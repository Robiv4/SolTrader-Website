"""Offline training CLI (explicit only; never runs automatically).

    python -m soltrader_ml.train --dataset ml/datasets/<version> --out ml/models --seed 42

Steps: data-quality gate -> chronological split with purge -> logistic baseline + LightGBM -> Platt calibration on
validation -> metrics on train / validation / untouched test -> walk-forward folds -> overfitting flags ->
readiness status -> JSON artifacts + metrics + report. Exit code 3 = data quality / size gate failed (no model).
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from .data import build_columns, load_dataset, load_schema, vectorize
from .metrics import classification_metrics, threshold_curve
from .models import LIGHTGBM_PARAMS, LIGHTGBM_ROUNDS, LOGISTIC_PARAMS, artifact_raw_score, export_artifact, fit_platt, probability, raw_score, train_lightgbm, train_logistic
from .split import assert_disjoint_groups, chronological_split, walk_forward

ALGORITHMS = {'logistic_regression': 'LR', 'lightgbm': 'LGBM'}
GATE = {'minRows': 300, 'minPositives': 30, 'minNegatives': 30}


def package_versions():
    return {name: importlib.metadata.version(name) for name in ['numpy', 'pandas', 'scikit-learn', 'lightgbm']}


def data_quality_report(frame, manifest, schema) -> dict:
    names = [spec['name'] for spec in schema['features']]
    duplicates_snapshots = int(frame['snapshot_id'].duplicated().sum())
    duplicates_candidates = int(frame['candidate_id'].duplicated().sum())
    times = frame['snapshot_at_ms'].to_numpy()
    report = {
        'rows': int(len(frame)),
        'positives': int(frame['label'].sum()),
        'negatives': int(len(frame) - frame['label'].sum()),
        'positiveRate': float(frame['label'].mean()) if len(frame) else None,
        'missingRates': {name: float(frame[name].isna().mean()) for name in names if name in frame},
        'invalidTimestamps': int((times <= 0).sum()),
        'unorderedTimestamps': int((np.diff(times) < 0).sum()) if len(times) > 1 else 0,
        'labelEndBeforeSnapshot': int((frame['label_end_ms'] < frame['snapshot_at_ms']).sum()),
        'duplicateSnapshots': duplicates_snapshots,
        'duplicateCandidates': duplicates_candidates,
        'leakageViolationsExcluded': manifest.get('leakageViolations', 0),
        'decisions': frame['decision'].value_counts().to_dict(),
        'sources': frame['source'].value_counts().to_dict(),
        'outcomeQuality': manifest.get('outcomeQuality', {}),
    }
    failures = []
    if report['rows'] < GATE['minRows']:
        failures.append(f"rows {report['rows']} < {GATE['minRows']}")
    if report['positives'] < GATE['minPositives']:
        failures.append(f"positives {report['positives']} < {GATE['minPositives']}")
    if report['negatives'] < GATE['minNegatives']:
        failures.append(f"negatives {report['negatives']} < {GATE['minNegatives']}")
    for key in ['invalidTimestamps', 'unorderedTimestamps', 'labelEndBeforeSnapshot', 'duplicateSnapshots', 'duplicateCandidates']:
        if report[key]:
            failures.append(f'{key}={report[key]}')
    report['passed'] = not failures
    report['failures'] = failures
    return report


def readiness(rows: int, positives: int, test_auc: float | None, overfitting: bool, fold_auc_std: float | None) -> str:
    if rows < 1000 or positives < 50:
        return 'INSUFFICIENT_DATA'
    if rows < 5000 or positives < 200:
        return 'RESEARCH_ONLY'
    if test_auc is not None and test_auc >= 0.60 and not overfitting and fold_auc_std is not None and fold_auc_std < 0.08:
        return 'SHADOW_READY'
    # PAPER_EXPERIMENT_ELIGIBLE is never assigned automatically (explicit future review).
    return 'RESEARCH_ONLY'


def feature_importance(algorithm, model, columns, x_test):
    by_feature: dict[str, float] = {}
    if algorithm == 'logistic_regression':
        for column, weight in zip(columns, model.coef_[0]):
            by_feature[column['feature']] = by_feature.get(column['feature'], 0.0) + abs(float(weight))
    else:
        if len(x_test):
            contrib = model.predict(x_test, pred_contrib=True)[:, :-1]  # TreeSHAP (LightGBM native), last column = bias
            values = np.abs(contrib).mean(axis=0)
        else:
            values = model.feature_importance(importance_type='gain')
        for column, value in zip(columns, values):
            by_feature[column['feature']] = by_feature.get(column['feature'], 0.0) + float(value)
    return sorted(({'feature': k, 'importance': v} for k, v in by_feature.items()), key=lambda item: -item['importance'])


def fit_and_score(algorithm, schema, frame, train_idx, seed, exclude_groups=None):
    train_frame = frame.iloc[train_idx]
    columns = build_columns(schema, train_frame, algorithm, exclude_groups)
    x_train = vectorize(train_frame, columns, algorithm)
    y_train = train_frame['label'].to_numpy().astype(int)
    model = train_logistic(x_train, y_train, seed) if algorithm == 'logistic_regression' else train_lightgbm(x_train, y_train, seed)
    return model, columns


def evaluate(algorithm, model, columns, frame, idx, calibration):
    part = frame.iloc[idx]
    x = vectorize(part, columns, algorithm)
    y = part['label'].to_numpy().astype(int)
    p = probability(raw_score(algorithm, model, x), calibration)
    return x, y, p


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--dataset', required=True)
    parser.add_argument('--out', default=str(Path(__file__).resolve().parents[1] / 'models'))
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--embargo-ms', type=int, default=60_000)
    parser.add_argument('--folds', type=int, default=4)
    parser.add_argument('--allow-small', action='store_true', help='smoke tests only: train despite the size gate (readiness stays INSUFFICIENT_DATA)')
    args = parser.parse_args(argv)
    random.seed(args.seed)
    np.random.seed(args.seed)

    dataset_dir = Path(args.dataset)
    frame, manifest = load_dataset(dataset_dir)
    schema = load_schema()
    if schema['featureVersion'] != manifest['featureVersion']:
        raise SystemExit(f"Feature version mismatch: schema {schema['featureVersion']} vs dataset {manifest['featureVersion']}")
    quality = data_quality_report(frame, manifest, schema)
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)
    if not quality['passed'] and not args.allow_small:
        report_path = out_root / f"quality-{manifest['version']}.json"
        report_path.write_text(json.dumps({'status': 'DATA_QUALITY_GATE_FAILED', 'quality': quality}, indent=2), encoding='utf-8')
        print(json.dumps({'status': 'DATA_QUALITY_GATE_FAILED', 'failures': quality['failures'], 'report': str(report_path)}))
        return 3

    times = frame['snapshot_at_ms'].to_numpy(dtype=np.int64)
    label_end = frame['label_end_ms'].to_numpy(dtype=np.int64)
    groups = frame['candidate_id'].to_numpy()
    split = chronological_split(times, label_end, embargo_ms=args.embargo_ms)
    assert_disjoint_groups(groups, split.train, split.validation, split.test)
    folds = walk_forward(times, label_end, folds=args.folds, embargo_ms=args.embargo_ms)
    pnl_all = frame['paper_net_pnl'].to_numpy(dtype=float)
    results = []
    for algorithm, short in ALGORITHMS.items():
        version = f"ML-{short}-{manifest['version']}-s{args.seed}"
        model, columns = fit_and_score(algorithm, schema, frame, split.train, args.seed)
        x_val, y_val, _ = evaluate(algorithm, model, columns, frame, split.validation, None)
        calibration = fit_platt(raw_score(algorithm, model, x_val), y_val) if len(y_val) else None
        metrics = {}
        for name, idx in [('train', split.train), ('validation', split.validation), ('test', split.test)]:
            _, y, p = evaluate(algorithm, model, columns, frame, idx, calibration)
            metrics[name] = classification_metrics(y, p)
        x_test, y_test, p_test = evaluate(algorithm, model, columns, frame, split.test, calibration)
        metrics['thresholdCurveTest'] = threshold_curve(y_test, p_test, pnl_all[split.test])
        fold_rows = []
        for fold in folds:
            if len(fold['train']) < 30 or len(np.unique(frame['label'].to_numpy()[fold['train']])) < 2:
                fold_rows.append({'fold': fold['fold'], 'skipped': 'too few training rows'})
                continue
            fold_model, fold_columns = fit_and_score(algorithm, schema, frame, fold['train'], args.seed)
            _, y_fold, p_fold = evaluate(algorithm, fold_model, fold_columns, frame, fold['test'], None)
            top = feature_importance(algorithm, fold_model, fold_columns, vectorize(frame.iloc[fold['test']], fold_columns, algorithm))[:5]
            fold_rows.append({'fold': fold['fold'], 'trainRows': int(len(fold['train'])), 'testRows': int(len(fold['test'])), 'purged': fold['purged'],
                              'metrics': classification_metrics(y_fold, p_fold), 'topFeatures': [item['feature'] for item in top]})
        fold_aucs = [row['metrics']['rocAuc'] for row in fold_rows if 'metrics' in row and row['metrics']['rocAuc'] is not None]
        train_auc, test_auc = metrics['train']['rocAuc'], metrics['test']['rocAuc']
        overfitting = bool(train_auc is not None and test_auc is not None and (train_auc - test_auc > 0.10 or (train_auc > 0.70 and test_auc < 0.55)))
        fold_std = float(np.std(fold_aucs)) if len(fold_aucs) >= 2 else None
        # Telegram / social ablation (does social add out-of-sample value?) - LightGBM only.
        ablation = None
        if algorithm == 'lightgbm':
            no_social, no_social_columns = fit_and_score(algorithm, schema, frame, split.train, args.seed, exclude_groups={'SOCIAL'})
            _, y_ns, p_ns = evaluate(algorithm, no_social, no_social_columns, frame, split.test, None)
            ablation = {'testRocAucWithoutSocial': classification_metrics(y_ns, p_ns)['rocAuc'], 'testRocAucWithSocial': classification_metrics(y_test, p_test)['rocAuc']}
        by_source = {}
        test_frame = frame.iloc[split.test]
        for source in sorted(test_frame['source'].unique()):
            mask = (test_frame['source'] == source).to_numpy()
            if mask.sum() >= 50:
                by_source[source] = classification_metrics(y_test[mask], p_test[mask])
            else:
                by_source[source] = {'n': int(mask.sum()), 'note': 'sample too small (< 50)'}
        status = readiness(quality['rows'], quality['positives'], test_auc, overfitting, fold_std)
        meta = {'modelVersion': version, 'featureVersion': manifest['featureVersion'], 'labelVersion': manifest['labelVersion'], 'target': manifest['target']}
        artifact = export_artifact(algorithm, model, columns, meta, calibration, 0.5)
        # Exported artifact must reproduce the library's raw scores exactly (train/serve consistency).
        exported = artifact_raw_score(artifact, x_test) if len(x_test) else np.array([])
        native = raw_score(algorithm, model, x_test) if len(x_test) else np.array([])
        max_diff = float(np.max(np.abs(exported - native))) if len(x_test) else 0.0
        if max_diff > 1e-6:
            raise SystemExit(f'Exported artifact does not reproduce {algorithm} scores (max diff {max_diff})')
        model_dir = out_root / version
        model_dir.mkdir(parents=True, exist_ok=True)
        artifact_text = json.dumps(artifact, separators=(',', ':'), sort_keys=True)
        (model_dir / 'model.json').write_text(artifact_text, encoding='utf-8')
        artifact_hash = hashlib.sha256(artifact_text.encode('utf-8')).hexdigest()
        parity_rows = frame.iloc[split.test[:40]]
        parity = [{'features': {spec['name']: (None if (value := row[spec['name']]) != value else (value.item() if hasattr(value, 'item') else value)) for spec in schema['features']},
                   'probability': float(probability(raw_score(algorithm, model, vectorize(parity_rows.iloc[[i]], columns, algorithm)), calibration)[0])}
                  for i, (_, row) in enumerate(parity_rows.iterrows())]
        (model_dir / 'parity.json').write_text(json.dumps(parity), encoding='utf-8')
        metadata = {
            'modelVersion': version, 'algorithm': algorithm, 'status': 'TRAINED', 'readiness': status, 'datasetVersion': manifest['version'],
            'featureVersion': manifest['featureVersion'], 'labelVersion': manifest['labelVersion'], 'target': manifest['target'],
            'config': {'seed': args.seed, 'embargoMs': args.embargo_ms, 'folds': args.folds, 'split': [0.70, 0.15, 0.15], 'calibration': 'platt(validation)',
                       'hyperparameters': LOGISTIC_PARAMS if algorithm == 'logistic_regression' else {**LIGHTGBM_PARAMS, 'rounds': LIGHTGBM_ROUNDS},
                       'allowSmall': args.allow_small},
            'periods': {'train': [int(times[split.train].min()), int(times[split.train].max())] if len(split.train) else None,
                        'validation': [int(times[split.validation].min()), int(times[split.validation].max())] if len(split.validation) else None,
                        'test': [int(times[split.test].min()), int(times[split.test].max())] if len(split.test) else None},
            'split': {'train': int(len(split.train)), 'validation': int(len(split.validation)), 'test': int(len(split.test)), 'boundaries': split.boundaries, 'purged': split.purged},
            'metrics': metrics, 'walkForward': fold_rows, 'walkForwardAucStd': fold_std, 'overfittingRisk': overfitting,
            'featureImportance': feature_importance(algorithm, model, columns, x_test)[:20], 'socialAblation': ablation, 'bySource': by_source,
            'calibration': calibration, 'quality': quality, 'artifactPath': str((model_dir / 'model.json').as_posix()), 'artifactHash': artifact_hash,
            'exportParityMaxDiff': max_diff, 'packages': package_versions(), 'python': platform.python_version(),
            'trainedAt': datetime.now(timezone.utc).isoformat(),
        }
        (model_dir / 'metadata.json').write_text(json.dumps(metadata, indent=2, default=str), encoding='utf-8')
        results.append({'modelVersion': version, 'algorithm': algorithm, 'readiness': status, 'testRocAuc': test_auc, 'testPrAuc': metrics['test']['prAuc'], 'overfittingRisk': overfitting, 'dir': str(model_dir)})
    print(json.dumps({'status': 'TRAINED', 'models': results}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
