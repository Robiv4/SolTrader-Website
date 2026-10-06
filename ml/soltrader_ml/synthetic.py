"""SYNTHETIC data for tests and smoke runs only (never used for any claim about real performance)."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from .data import META_COLUMNS, load_schema


def make_synthetic_dataset(directory: Path, rows: int = 1200, seed: int = 7) -> Path:
    rng = np.random.default_rng(seed)
    schema = load_schema()
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
            if spec['group'] == 'SOCIAL':
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
    manifest = {'version': f'SYNTHETIC-{seed}-{rows}', 'featureVersion': schema['featureVersion'], 'labelVersion': 'ML-LABELS-v1', 'target': 'plus20BeforeMinus10_30m',
                'synthetic': True, 'leakageViolations': 0, 'outcomeQuality': {'COMPLETE': rows}}
    (directory / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    return directory
