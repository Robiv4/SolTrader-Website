"""Autonomous ML bundle trainer (ML-FEATURES-AUTONOMOUS-v1, AUTO-LABELS-v1).

Components (one immutable bundle, exported as trees for the TypeScript runtime):
  entryReturn   LightGBM regression  - expected net return of an entry (fees + impact) over the entry horizon
  entryDownside LightGBM regression  - expected worst net result inside the horizon
  entryProfit   LightGBM binary      - P(net > 0), Platt-calibrated on validation
  exitAdvantage LightGBM regression  - expected net advantage of holding vs selling now
  exitHold      LightGBM binary      - P(holding beats selling now), Platt-calibrated on validation

Policy thresholds (BUY / WAIT / SKIP, HOLD / PARTIAL_SELL / SELL) are chosen on VALIDATION data by the realised net
result of the decisions; the TEST block is only used for the final report (backtest, stress tests, regimes, periods).
Splits are chronological with purge + embargo, and a token (group_id) never appears in two blocks.
Readiness is conservative; a successful training run never means "fit to trade".
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
from datetime import datetime, timezone
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from .data import build_columns, load_schema, vectorize
from .metrics import classification_metrics, trading_stats
from .models import LIGHTGBM_PARAMS, artifact_raw_score, export_artifact, fit_platt, probability, raw_score
from .split import chronological_split, walk_forward
from .train import package_versions

BUNDLE_FORMAT = 'soltrader-autonomous-bundle-v1'
EXCLUDED_GROUPS = {'PORTFOLIO'}  # not reconstructable for replayed rows; used by sizing / protection only
MIN_ROWS_PER_KIND = 300
READY_MIN_ROWS = 2000
ROUNDS = 200
DEFAULT_SIZING = {'method': 'EDGE_OVER_DOWNSIDE', 'baseFractionPct': 2.0, 'maxFractionPct': 5.0, 'minOrderUsd': 5.0, 'maxImpactPct': 8.0}
NEVER_BUY = {'minProbability': 1.01, 'minExpectedNetPct': 1e6, 'minDownsideNetPct': 0.0, 'waitMinProbability': 1.01}


def emit(stage: str, **details):
    """Real pipeline stage for the web progress view (one JSON line on stdout; the final line is the result)."""
    print(json.dumps({'event': 'STAGE', 'stage': stage, **details}), flush=True)


def load_autonomous(directory: Path):
    manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
    frame = pd.read_csv(directory / 'dataset.csv', dtype={'row_id': str, 'group_id': str, 'kind': str, 'origin': str, 'market_regime': str}, keep_default_na=True)
    frame = frame.sort_values(['snapshot_at_ms', 'row_id'], kind='mergesort').reset_index(drop=True)
    return frame, manifest


def group_safe_split(frame: pd.DataFrame, embargo_ms: int):
    """Chronological split + purge / embargo; then rows whose token also appears in a later block are removed."""
    times = frame['snapshot_at_ms'].to_numpy(dtype=np.int64)
    label_end = frame['label_end_ms'].to_numpy(dtype=np.int64)
    split = chronological_split(times, label_end, embargo_ms=embargo_ms)
    groups = frame['group_id'].to_numpy()
    test_groups = set(groups[split.test].tolist())
    val_idx = np.array([i for i in split.validation if groups[i] not in test_groups], dtype=int)
    later = test_groups | set(groups[val_idx].tolist())
    train_idx = np.array([i for i in split.train if groups[i] not in later], dtype=int)
    purged = {**split.purged, 'groupTrain': int(len(split.train) - len(train_idx)), 'groupValidation': int(len(split.validation) - len(val_idx))}
    return train_idx, val_idx, split.test, {**split.boundaries}, purged


def lgb_params(objective: str, seed: int, n: int):
    params = {**LIGHTGBM_PARAMS, 'seed': seed, 'bagging_seed': seed, 'feature_fraction_seed': seed, 'data_random_seed': seed, 'min_data_in_leaf': max(20, int(n * 0.01))}
    if objective == 'regression':
        params.update({'objective': 'huber', 'alpha': 5.0})
        params.pop('is_unbalance', None)
    return params


def fit(objective: str, x: np.ndarray, y: np.ndarray, seed: int):
    return lgb.train(lgb_params(objective, seed, len(y)), lgb.Dataset(x, label=y, free_raw_data=False), num_boost_round=ROUNDS)


def spearman(a: np.ndarray, b: np.ndarray):
    if len(a) < 3 or np.std(a) == 0 or np.std(b) == 0:
        return None
    return float(pd.Series(a).rank().corr(pd.Series(b).rank()))


def regression_metrics(y: np.ndarray, p: np.ndarray):
    if not len(y):
        return {'n': 0}
    residual = y - p
    total = float(((y - y.mean()) ** 2).sum())
    return {'n': int(len(y)), 'mae': float(np.abs(residual).mean()), 'spearman': spearman(y, p), 'r2': float(1 - (residual ** 2).sum() / total) if total > 0 else None, 'meanLabel': float(y.mean()), 'meanPrediction': float(p.mean())}


def entry_selected(policy: dict, p: np.ndarray, expected: np.ndarray, downside: np.ndarray):
    return (p >= policy['minProbability']) & (expected >= policy['minExpectedNetPct']) & (np.minimum(downside, expected) >= policy['minDownsideNetPct'])


def choose_entry_policy(p, expected, downside, net):
    best, best_value = None, 0.0
    min_trades = max(10, int(len(net) * 0.02))
    for min_p in [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]:
        for min_e in [0.0, 0.5, 1.0, 2.0, 3.0, 5.0]:
            for min_d in [-50.0, -30.0, -20.0, -10.0]:
                policy = {'minProbability': min_p, 'minExpectedNetPct': min_e, 'minDownsideNetPct': min_d, 'waitMinProbability': round(min_p - 0.1, 2)}
                mask = entry_selected(policy, p, expected, downside)
                if mask.sum() < min_trades:
                    continue
                value = float(net[mask].sum())
                if value > best_value:
                    best, best_value = policy, value
    # No policy is profitable on validation: the bundle never buys (SKIP is a valid, learned decision).
    return best or dict(NEVER_BUY), best_value


def exit_actions(policy: dict, advantage: np.ndarray, p_hold: np.ndarray):
    sell = (advantage <= policy['sellBelowAdvantagePct']) | (p_hold < policy['minHoldProbability'])
    partial = ~sell & (advantage <= policy['partialBelowAdvantagePct'])
    return sell, partial


def exit_value(policy, advantage, p_hold, realised):
    """Value vs selling now: a SELL realises 0, a HOLD realises the true advantage, a PARTIAL half of it."""
    sell, partial = exit_actions(policy, advantage, p_hold)
    return float(np.where(sell, 0.0, np.where(partial, 0.5 * realised, realised)).sum())


def choose_exit_policy(advantage, p_hold, realised):
    best, best_value = None, -math.inf
    for sell_below in [-5.0, -3.0, -2.0, -1.0, -0.5, 0.0]:
        for min_hold in [0.3, 0.4, 0.5]:
            policy = {'sellBelowAdvantagePct': sell_below, 'partialBelowAdvantagePct': round(sell_below / 2, 3), 'minHoldProbability': min_hold, 'partialSellFraction': 0.5}
            value = exit_value(policy, advantage, p_hold, realised)
            if value > best_value:
                best, best_value = policy, value
    return best, best_value


def backtest(net: np.ndarray, cost_impact: np.ndarray, mask: np.ndarray, size_usd: float = 20.0):
    pnl = net[mask] / 100 * size_usd
    stats = trading_stats(pnl)
    stats['impactAndFeesUsd'] = float((cost_impact[mask] / 100 * size_usd).sum()) if mask.any() else 0.0
    return stats


def main(argv=None):
    parser = argparse.ArgumentParser(description='Train the Autonomous ML bundle')
    parser.add_argument('--dataset', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--embargo-ms', type=int, default=60_000)
    parser.add_argument('--allow-small', action='store_true', help='smoke tests only (readiness stays INSUFFICIENT_DATA)')
    args = parser.parse_args(argv)
    random.seed(args.seed)
    np.random.seed(args.seed)
    directory = Path(args.dataset)
    frame, manifest = load_autonomous(directory)
    schema = load_schema(feature_version=manifest['featureVersion'])
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)
    version = f"ML-AUTO-{manifest['version']}-s{args.seed}"
    model_dir = out_root / version
    if model_dir.exists() and any(model_dir.glob('*')):
        print(json.dumps({'status': 'MODEL_VERSION_EXISTS', 'failures': [f'{version} already exists (immutable)']}))
        return 4
    entry = frame[(frame['kind'] == 'ENTRY') & frame['entry_net_pct'].notna()].reset_index(drop=True)
    position = frame[(frame['kind'] == 'POSITION') & frame['hold_advantage_pct'].notna()].reset_index(drop=True)
    failures = []
    if len(entry) < MIN_ROWS_PER_KIND:
        failures.append(f'ENTRY rows {len(entry)} < {MIN_ROWS_PER_KIND}')
    if len(position) < MIN_ROWS_PER_KIND:
        failures.append(f'POSITION rows {len(position)} < {MIN_ROWS_PER_KIND}')
    if failures and not args.allow_small:
        print(json.dumps({'status': 'DATA_QUALITY_GATE_FAILED', 'failures': failures}))
        return 3

    meta = {'featureVersion': manifest['featureVersion'], 'labelVersion': manifest['labelVersion']}
    components, metrics = {}, {'entry': {}, 'exit': {}}
    emit('ENTRY_MODELS', entryRows=int(len(entry)))

    # ---------------- entry components
    tr, va, te, boundaries_entry, purged_entry = group_safe_split(entry, args.embargo_ms)
    cols = build_columns(schema, entry.iloc[tr], 'lightgbm', exclude_groups=EXCLUDED_GROUPS)
    x = vectorize(entry, cols, 'lightgbm')
    net = entry['entry_net_pct'].to_numpy(dtype=float)
    down = entry['entry_downside_pct'].to_numpy(dtype=float)
    profit = (net > 0).astype(int)
    m_ret = fit('regression', x[tr], net[tr], args.seed)
    m_down = fit('regression', x[tr], down[tr], args.seed)
    m_prof = fit('binary', x[tr], profit[tr], args.seed)
    cal_prof = fit_platt(raw_score('lightgbm', m_prof, x[va]), profit[va]) if len(va) else None
    pred = {name: model.predict(x, raw_score=True) for name, model in [('ret', m_ret), ('down', m_down), ('prof', m_prof)]}
    p_prof = probability(pred['prof'], cal_prof)
    entry_policy, val_value = choose_entry_policy(p_prof[va], pred['ret'][va], pred['down'][va], net[va])
    cost_impact = entry['entry_cost_pct'].fillna(0).to_numpy(dtype=float)
    impact_parts = (entry['entry_entry_impact_pct'].fillna(0) + entry['entry_exit_impact_pct'].fillna(0)).to_numpy(dtype=float)
    selected = entry_selected(entry_policy, p_prof, pred['ret'], pred['down'])
    test_mask = np.zeros(len(entry), dtype=bool)
    test_mask[te] = True
    rng = np.random.default_rng(args.seed)
    random_mask = np.zeros(len(entry), dtype=bool)
    chosen = int((selected & test_mask).sum())
    if chosen and len(te):
        random_mask[rng.choice(te, size=min(chosen, len(te)), replace=False)] = True
    stress = {f'impactX{m}': backtest(net - (m - 1) * impact_parts, cost_impact, selected & test_mask) for m in (2, 3)}
    regimes = {}
    for regime in sorted(entry['market_regime'].fillna('UNKNOWN').unique()):
        mask = test_mask & (entry['market_regime'].fillna('UNKNOWN') == regime).to_numpy()
        regimes[regime] = {'rows': int(mask.sum()), **backtest(net, cost_impact, selected & mask)}
    periods = []
    for block in np.array_split(np.array(te), 3) if len(te) >= 3 else []:
        mask = np.zeros(len(entry), dtype=bool)
        mask[block] = True
        periods.append({'fromMs': int(entry['snapshot_at_ms'].iloc[block[0]]), 'toMs': int(entry['snapshot_at_ms'].iloc[block[-1]]), **backtest(net, cost_impact, selected & mask)})
    positives_skipped = test_mask & ~selected & (net > 0)
    folds = []
    for fold in walk_forward(entry['snapshot_at_ms'].to_numpy(dtype=np.int64), entry['label_end_ms'].to_numpy(dtype=np.int64), folds=4, embargo_ms=args.embargo_ms):
        if len(fold['train']) < 50 or len(fold['test']) < 10:
            continue
        f_cols = build_columns(schema, entry.iloc[fold['train']], 'lightgbm', exclude_groups=EXCLUDED_GROUPS)
        fx = vectorize(entry, f_cols, 'lightgbm')
        f_ret = fit('regression', fx[fold['train']], net[fold['train']], args.seed).predict(fx[fold['test']], raw_score=True)
        f_down = fit('regression', fx[fold['train']], down[fold['train']], args.seed).predict(fx[fold['test']], raw_score=True)
        f_prof = probability(fit('binary', fx[fold['train']], profit[fold['train']], args.seed).predict(fx[fold['test']], raw_score=True), None)
        mask = entry_selected(entry_policy, f_prof, f_ret, f_down)
        folds.append({'fold': fold['fold'], 'testRows': int(len(fold['test'])), 'spearman': spearman(net[fold['test']], f_ret), **backtest(net[fold['test']], cost_impact[fold['test']], mask)})
    train_rho, test_rho = spearman(net[tr], pred['ret'][tr]), spearman(net[te], pred['ret'][te])
    metrics['entry'] = {
        'rows': {'train': int(len(tr)), 'validation': int(len(va)), 'test': int(len(te))}, 'split': {'boundaries': boundaries_entry, 'purged': purged_entry},
        'entryReturn': {'train': regression_metrics(net[tr], pred['ret'][tr]), 'test': regression_metrics(net[te], pred['ret'][te])},
        'entryDownside': {'test': regression_metrics(down[te], pred['down'][te])},
        'entryProfit': {'test': classification_metrics(profit[te], p_prof[te]) if len(np.unique(profit[te])) > 1 else {'n': int(len(te))}},
        'policyValidationNetPct': val_value,
        'backtest': {'policy': backtest(net, cost_impact, selected & test_mask), 'buyAll': backtest(net, cost_impact, test_mask), 'randomSameCount': backtest(net, cost_impact, random_mask & test_mask), 'skipAll': trading_stats(np.array([]))},
        'missedOpportunities': {'positiveRowsSkipped': int(positives_skipped.sum()), 'netPctSkipped': float(net[positives_skipped].sum())},
        'liquidityStress': stress, 'regimes': regimes, 'periods': periods, 'walkForward': folds,
        'overfitting': {'trainSpearman': train_rho, 'testSpearman': test_rho, 'risk': bool(train_rho is not None and test_rho is not None and train_rho - test_rho > 0.25)},
    }
    for name, model, objective, calibration in [('entryReturn', m_ret, 'regression', None), ('entryDownside', m_down, 'regression', None), ('entryProfit', m_prof, 'binary', cal_prof)]:
        artifact = export_artifact('lightgbm', model, cols, {**meta, 'modelVersion': f'{version}:{name}', 'target': name}, calibration, 0.5)
        artifact['objective'] = objective
        components[name] = artifact

    # ---------------- exit components
    emit('EXIT_MODELS', positionRows=int(len(position)))
    tr, va, te, boundaries_exit, purged_exit = group_safe_split(position, args.embargo_ms)
    pcols = build_columns(schema, position.iloc[tr], 'lightgbm', exclude_groups=EXCLUDED_GROUPS)
    px = vectorize(position, pcols, 'lightgbm')
    adv = position['hold_advantage_pct'].to_numpy(dtype=float)
    hold = (adv > 0).astype(int)
    m_adv = fit('regression', px[tr], adv[tr], args.seed)
    m_hold = fit('binary', px[tr], hold[tr], args.seed)
    cal_hold = fit_platt(raw_score('lightgbm', m_hold, px[va]), hold[va]) if len(va) else None
    p_adv = m_adv.predict(px, raw_score=True)
    p_hold = probability(m_hold.predict(px, raw_score=True), cal_hold)
    exit_policy, exit_val = choose_exit_policy(p_adv[va], p_hold[va], adv[va])
    sell, partial = exit_actions(exit_policy, p_adv[te], p_hold[te])
    metrics['exit'] = {
        'rows': {'train': int(len(tr)), 'validation': int(len(va)), 'test': int(len(te))}, 'split': {'boundaries': boundaries_exit, 'purged': purged_exit},
        'exitAdvantage': {'train': regression_metrics(adv[tr], p_adv[tr]), 'test': regression_metrics(adv[te], p_adv[te])},
        'exitHold': {'test': classification_metrics(hold[te], p_hold[te]) if len(np.unique(hold[te])) > 1 else {'n': int(len(te))}},
        'policyValidationValuePct': exit_val,
        'test': {'policyValuePct': exit_value(exit_policy, p_adv[te], p_hold[te], adv[te]), 'alwaysHoldValuePct': float(adv[te].sum()), 'alwaysSellValuePct': 0.0, 'sellShare': float(sell.mean()) if len(te) else None, 'partialShare': float(partial.mean()) if len(te) else None},
    }
    for name, model, objective, calibration in [('exitAdvantage', m_adv, 'regression', None), ('exitHold', m_hold, 'binary', cal_hold)]:
        artifact = export_artifact('lightgbm', model, pcols, {**meta, 'modelVersion': f'{version}:{name}', 'target': name}, calibration, 0.5)
        artifact['objective'] = objective
        components[name] = artifact

    # ---------------- sizing (v1: deterministic policy over the outputs, not a learned model) + validation
    emit('POSITION_SIZING', method=DEFAULT_SIZING['method'], learned=False)
    emit('VALIDATION')
    # ---------------- parity: exported trees == LightGBM (the TypeScript runtime replays the same trees)
    parity = 0.0
    for name, model, matrix in [('entryReturn', m_ret, x), ('entryProfit', m_prof, x), ('exitAdvantage', m_adv, px)]:
        sample = matrix[: min(200, len(matrix))]
        parity = max(parity, float(np.max(np.abs(artifact_raw_score(components[name], sample) - model.predict(sample, raw_score=True)))) if len(sample) else 0.0)
    if parity > 1e-6:
        print(json.dumps({'status': 'EXPORT_PARITY_FAILED', 'failures': [f'max diff {parity}']}))
        return 5

    test_bt = metrics['entry']['backtest']['policy']
    stressed = metrics['entry']['liquidityStress']['impactX2']
    positive_folds = [fold for fold in folds if fold['netPnl'] > 0]
    ready = (
        not failures and len(entry) >= READY_MIN_ROWS and len(position) >= READY_MIN_ROWS and test_bt['trades'] >= 30 and test_bt['netPnl'] > 0
        and (test_bt['profitFactor'] or 0) >= 1.2 and stressed['netPnl'] > 0 and len(folds) >= 3 and len(positive_folds) / len(folds) >= 0.75 and not metrics['entry']['overfitting']['risk']
        and metrics['exit']['test']['policyValuePct'] >= 0
    )
    readiness = 'INSUFFICIENT_DATA' if failures or len(entry) < READY_MIN_ROWS or len(position) < READY_MIN_ROWS else 'SHADOW_READY' if ready else 'RESEARCH_ONLY'
    trained_at = datetime.now(timezone.utc).isoformat()
    bundle = {
        'format': BUNDLE_FORMAT, 'bundleVersion': version, 'featureVersion': manifest['featureVersion'], 'labelVersion': manifest['labelVersion'], 'datasetVersion': manifest['version'],
        'createdAt': trained_at, 'components': components, 'policy': {'entry': entry_policy, 'exit': exit_policy}, 'sizing': dict(DEFAULT_SIZING),
    }
    emit('SAVING', readiness=readiness)
    model_dir.mkdir(parents=True, exist_ok=True)
    text = json.dumps(bundle, separators=(',', ':'))
    (model_dir / 'bundle.json').write_text(text, encoding='utf-8')
    artifact_hash = hashlib.sha256(text.encode('utf-8')).hexdigest()
    metadata = {
        'bundleVersion': version, 'status': 'TRAINED', 'readiness': readiness, 'featureVersion': manifest['featureVersion'], 'labelVersion': manifest['labelVersion'], 'datasetVersion': manifest['version'],
        'policy': bundle['policy'], 'sizing': bundle['sizing'], 'metrics': {**metrics, 'exportParityMaxDiff': parity, 'dataQualityFailures': failures, 'coverage': manifest.get('coverage')},
        'artifactHash': artifact_hash, 'trainedAt': trained_at, 'packages': package_versions(), 'seed': args.seed,
    }
    (model_dir / 'metadata.json').write_text(json.dumps(metadata, indent=2, default=str), encoding='utf-8')
    # Parity fixture rows for the TypeScript test (features + expected raw outputs).
    sample = entry.head(20)
    sample_x = vectorize(sample, cols, 'lightgbm')
    rows = [{'features': {spec['name']: (None if pd.isna(sample.iloc[i].get(spec['name'])) else sample.iloc[i].get(spec['name'])) for spec in schema['features'] if spec['name'] in sample.columns},
             'entryReturn': float(m_ret.predict(sample_x[i:i + 1], raw_score=True)[0])} for i in range(len(sample))]
    (model_dir / 'parity.json').write_text(json.dumps(rows, default=lambda value: value.item() if hasattr(value, 'item') else str(value)), encoding='utf-8')
    print(json.dumps({'status': 'TRAINED', 'bundleVersion': version, 'readiness': readiness, 'dir': str(model_dir)}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
