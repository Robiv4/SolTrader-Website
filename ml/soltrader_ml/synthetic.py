"""SYNTHETIC data for tests and smoke runs only (never used for any claim about real performance)."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from .data import META_COLUMNS, load_schema


def make_synthetic_dataset(directory: Path, rows: int = 1200, seed: int = 7, feature_version: str | None = None, version: str | None = None) -> Path:
    rng = np.random.default_rng(seed)
    schema = load_schema(feature_version=feature_version)
    start = 1_790_000_000_000
    times = start + np.cumsum(rng.integers(5_000, 60_000, size=rows))
    data: dict[str, object] = {}
    for spec in schema['features']:
        name = spec['name']
        if spec['type'] == 'category':
            data[name] = rng.choice(spec['values'], size=rows, p=[0.9, 0.08, 0.02] if len(spec['values']) == 3 else None)
        elif spec['type'] == 'boolean':
            values = rng.integers(0, 2, size=rows).astype(float)
            values[rng.random(rows) < 0.15] = np.nan
            data[name] = values
        else:
            values = np.abs(rng.normal(50, 40, size=rows))
            if spec['group'] in ('SOCIAL', 'COMMUNITY'):
                values[rng.random(rows) < 0.8] = np.nan
            elif rng.random() < 0.3:
                values[rng.random(rows) < 0.1] = np.nan
            data[name] = values
    frame = pd.DataFrame(data)
    signal = 0.04 * np.nan_to_num(frame['uniqueBuyers'].to_numpy(dtype=float)) - 0.03 * np.nan_to_num(frame['launchExhaustionScore'].to_numpy(dtype=float)) + rng.normal(0, 1.5, rows)
    label = (signal > np.quantile(signal, 0.8)).astype(int)
    pnl = np.where(rng.random(rows) < 0.1, np.where(label == 1, rng.normal(3, 2, rows), rng.normal(-2, 2, rows)), np.nan)
    meta = pd.DataFrame({
        'snapshot_id': [f's{i:05d}' for i in range(rows)], 'candidate_id': [f'c{i:05d}' for i in range(rows)], 'mint': [f'm{i:05d}' for i in range(rows)],
        'source': frame['source'], 'snapshot_kind': 'AGE_30S', 'snapshot_at_ms': times, 'label_end_ms': times + 1_800_000,
        'decision': rng.choice(['BUY', 'WATCH', 'REJECT'], size=rows, p=[0.05, 0.6, 0.35]), 'label': label, 'paper_net_pnl': pnl,
    })
    feature_columns = [spec['name'] for spec in schema['features'] if spec['name'] not in META_COLUMNS]
    out = pd.concat([meta[META_COLUMNS], frame[feature_columns]], axis=1)
    directory.mkdir(parents=True, exist_ok=True)
    out.to_csv(directory / 'dataset.csv', index=False)
    manifest = {'version': version or f'SYNTHETIC-{seed}-{rows}', 'featureVersion': schema['featureVersion'], 'labelVersion': 'ML-LABELS-v1', 'target': 'plus20BeforeMinus10_30m',
                'synthetic': True, 'leakageViolations': 0, 'outcomeQuality': {'COMPLETE': rows}}
    (directory / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    return directory


def make_autonomous_dataset(directory: Path, rows: int = 2400, seed: int = 11, version: str = 'AUTO-SYNTHETIC') -> Path:
    """SYNTHETIC autonomous dataset (tests only): ENTRY rows whose net return depends on ret1mPct / uniqueBuyers, POSITION
    rows whose hold advantage depends on ret30sPct / drawdownFromPeakPct. Never used for any performance claim."""
    rng = np.random.default_rng(seed)
    schema = load_schema(feature_version='ML-FEATURES-AUTONOMOUS-v1')
    start = 1_790_000_000_000
    times = start + np.cumsum(rng.integers(5_000, 30_000, size=rows))
    kinds = np.where(rng.random(rows) < 0.5, 'ENTRY', 'POSITION')
    data: dict[str, object] = {}
    for spec in schema['features']:
        name = spec['name']
        if spec['type'] == 'category':
            data[name] = rng.choice(spec['values'], size=rows)
        elif spec['type'] == 'boolean':
            data[name] = rng.integers(0, 2, size=rows).astype(float)
        else:
            values = rng.normal(0, 20, size=rows)
            if spec['group'] in ('SOCIAL', 'COMMUNITY', 'PORTFOLIO'):
                values[rng.random(rows) < 0.7] = np.nan
            data[name] = values
    frame = pd.DataFrame(data)
    frame['decisionKind'] = kinds
    signal = 0.08 * frame['ret1mPct'].to_numpy() + 0.05 * np.nan_to_num(frame['uniqueBuyers'].to_numpy()) + rng.normal(0, 2, rows)
    entry_net = np.where(kinds == 'ENTRY', signal - 1.0, np.nan)
    hold_adv = np.where(kinds == 'POSITION', 0.06 * frame['ret30sPct'].to_numpy() - 0.04 * frame['drawdownFromPeakPct'].to_numpy() + rng.normal(0, 1, rows), np.nan)
    meta = pd.DataFrame({
        'row_id': [f'r{i:05d}' for i in range(rows)], 'group_id': [f'm{i // 3:05d}' for i in range(rows)], 'kind': kinds, 'origin': 'REPLAY',
        'snapshot_at_ms': times, 'label_end_ms': times + np.where(kinds == 'ENTRY', 600_000, 120_000), 'market_regime': rng.choice(['HOT', 'NORMAL', 'COLD', ''], size=rows),
        'entry_net_pct': entry_net, 'entry_downside_pct': np.where(kinds == 'ENTRY', np.minimum(entry_net, entry_net - np.abs(rng.normal(3, 2, rows))), np.nan),
        'entry_gross_pct': np.where(kinds == 'ENTRY', entry_net + 1.2, np.nan), 'entry_cost_pct': np.where(kinds == 'ENTRY', 1.2, np.nan),
        'entry_entry_impact_pct': np.where(kinds == 'ENTRY', 0.4, np.nan), 'entry_exit_impact_pct': np.where(kinds == 'ENTRY', 0.2, np.nan),
        'hold_advantage_pct': hold_adv, 'sell_now_net_pct': np.where(kinds == 'POSITION', rng.normal(0, 10, rows), np.nan), 'label_resolution_ms': 1000, 'liquidity_assumed': 0,
    })
    names = [spec['name'] for spec in schema['features']]
    out = pd.concat([meta, frame[names]], axis=1)
    directory.mkdir(parents=True, exist_ok=True)
    out.to_csv(directory / 'dataset.csv', index=False)
    manifest = {'version': version, 'featureVersion': 'ML-FEATURES-AUTONOMOUS-v1', 'labelVersion': 'AUTO-LABELS-v1', 'target': 'AUTONOMOUS_NET_PNL', 'synthetic': True, 'rows': rows}
    (directory / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    return directory
