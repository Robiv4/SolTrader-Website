"""Dataset loading and schema-driven encoding.

The column specs produced here are exported inside the model artifact and replayed by the TypeScript inference
(packages/strategy-engine/src/ml/model.ts). Any change here must keep both sides identical (parity test).
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

META_COLUMNS = ['snapshot_id', 'candidate_id', 'mint', 'source', 'snapshot_kind', 'snapshot_at_ms', 'label_end_ms', 'decision', 'label', 'paper_net_pnl']
ROOT = Path(__file__).resolve().parents[1]


def load_schema(path: Path | None = None) -> dict:
    schema_path = path or ROOT / 'schema' / 'features-v1.json'
    return json.loads(schema_path.read_text(encoding='utf-8'))


def load_dataset(directory: Path) -> tuple[pd.DataFrame, dict]:
    manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
    frame = pd.read_csv(directory / 'dataset.csv', dtype={'snapshot_id': str, 'candidate_id': str, 'mint': str, 'source': str, 'decision': str}, keep_default_na=True)
    frame = frame.sort_values(['snapshot_at_ms', 'snapshot_id'], kind='mergesort').reset_index(drop=True)
    return frame, manifest


def transform(value: float, kind: str | None) -> float:
    """Same as applyTransform() in model.ts."""
    if kind == 'log1p':
        return math.log1p(max(0.0, value))
    if kind == 'signed_log1p':
        return math.copysign(math.log1p(abs(value)), value) if value != 0 else 0.0
    return value


def _raw_numeric(series: pd.Series) -> np.ndarray:
    return pd.to_numeric(series, errors='coerce').to_numpy(dtype=float)


def build_columns(schema: dict, frame: pd.DataFrame, algorithm: str, exclude_groups: set[str] | None = None) -> list[dict]:
    """Column specs (fitted on TRAINING rows only: imputation / standardisation never see validation or test data)."""
    columns: list[dict] = []
    for spec in schema['features']:
        if exclude_groups and spec['group'] in exclude_groups:
            continue
        name = spec['name']
        if spec['type'] == 'category':
            for value in spec['values']:
                columns.append({'name': f'{name}={value}', 'feature': name, 'kind': 'onehot', 'category': value})
            continue
        raw = _raw_numeric(frame[name]) if name in frame else np.full(len(frame), np.nan)
        transformed = np.array([transform(v, spec.get('transform')) if not np.isnan(v) else np.nan for v in raw])
        column = {'name': name, 'feature': name, 'kind': 'value', 'transform': spec.get('transform')}
        if algorithm == 'logistic_regression':
            finite = transformed[~np.isnan(transformed)]
            impute = float(np.median(finite)) if finite.size else 0.0
            filled = np.where(np.isnan(transformed), impute, transformed)
            std = float(filled.std())
            column.update({'impute': impute, 'mean': float(filled.mean()), 'std': std if std > 1e-12 else 1.0})
        columns.append(column)
        # Missingness can be informative: an explicit indicator (never a silent zero).
        if np.isnan(raw).any():
            columns.append({'name': f'{name}__missing', 'feature': name, 'kind': 'missing'})
    return columns


def vectorize(frame: pd.DataFrame, columns: list[dict], algorithm: str) -> np.ndarray:
    """Mirror of vectorize() in model.ts (NaN = missing for tree models)."""
    linear = algorithm == 'logistic_regression'
    matrix = np.zeros((len(frame), len(columns)), dtype=float)
    for j, column in enumerate(columns):
        feature = column['feature']
        series = frame[feature] if feature in frame else pd.Series([np.nan] * len(frame))
        if column['kind'] == 'onehot':
            matrix[:, j] = (series.astype(str).to_numpy() == column['category']).astype(float)
            continue
        raw = _raw_numeric(series) if column['kind'] != 'onehot' else None
        if column['kind'] == 'missing':
            matrix[:, j] = np.isnan(raw).astype(float)
            continue
        values = np.array([transform(v, column.get('transform')) if not np.isnan(v) else np.nan for v in raw])
        if linear:
            values = np.where(np.isnan(values), column['impute'], values)
            values = (values - column['mean']) / (column['std'] if column['std'] > 0 else 1.0)
        matrix[:, j] = values
    return matrix
