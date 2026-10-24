"""Bounded-memory access to an Autonomous ML dataset (ENTRY / POSITION rows) for the trainer.

The CSV is read in chunks (never as one DataFrame): one pass for the meta / label columns (small), one pass for the
feature values, which go into a disk-backed float64 memmap per kind (raw values exactly as pandas parses them) plus
small integer codes for the category features. Column specs, matrices and predictions are then computed block-wise
from those arrays. Everything mirrors the in-memory path (load_autonomous + data.build_columns / data.vectorize) value
for value, so the trained bundle is identical; only the peak memory differs.

InMemoryKind keeps the original in-memory implementation (small datasets, tests, parity reference).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

from .data import build_columns, transform, vectorize

META_DTYPES = {'row_id': str, 'group_id': str, 'kind': str, 'origin': str, 'market_regime': str}
META_COLUMNS = ['row_id', 'group_id', 'kind', 'origin', 'snapshot_at_ms', 'label_end_ms', 'market_regime']
LABEL_COLUMNS = ['entry_net_pct', 'entry_downside_pct', 'entry_gross_pct', 'entry_cost_pct', 'entry_entry_impact_pct', 'entry_exit_impact_pct', 'hold_advantage_pct', 'sell_now_net_pct', 'label_resolution_ms', 'liquidity_assumed']
KIND_LABEL = {'ENTRY': 'entry_net_pct', 'POSITION': 'hold_advantage_pct'}
DEFAULT_CHUNK_ROWS = 20_000
DEFAULT_BLOCK_ROWS = 20_000
# Matrices larger than this are memory-mapped files in the work directory instead of RAM.
MEMMAP_MIN_BYTES = 64 * 1024 * 1024


def _vectorize_values(raw: np.ndarray, kind: str | None) -> np.ndarray:
    """Exactly the element-wise expression of data.vectorize / build_columns (same transform(), same NaN handling)."""
    return np.array([transform(v, kind) if not np.isnan(v) else np.nan for v in raw])


class InMemoryKind:
    """Rows of one kind as a DataFrame (the original implementation)."""

    def __init__(self, frame: pd.DataFrame):
        self.frame = frame
        self.meta = frame
        self.n = len(frame)

    def columns(self, schema: dict, idx, exclude_groups):
        return build_columns(schema, self.frame.iloc[idx], 'lightgbm', exclude_groups=exclude_groups)

    def matrix(self, columns: list[dict], idx) -> np.ndarray:
        return vectorize(self.frame.iloc[idx], columns, 'lightgbm')

    def predict(self, model, columns: list[dict], idx=None) -> np.ndarray:
        x = vectorize(self.frame if idx is None else self.frame.iloc[idx], columns, 'lightgbm')
        return model.predict(x, raw_score=True)

    def raw_rows(self, count: int) -> list[dict]:
        sample = self.frame.head(count)
        return [{name: sample.iloc[i].get(name) for name in sample.columns} for i in range(len(sample))]


class StreamingKind:
    """Rows of one kind: meta in RAM, raw feature values in a memmap, matrices built block by block."""

    def __init__(self, meta: pd.DataFrame, raw: np.ndarray, numeric: list[str], codes: dict[str, np.ndarray], values: dict[str, list[str]], absent: set[str], work_dir: Path, tag: str, block_rows: int):
        self.meta = meta
        self.n = len(meta)
        self.raw = raw
        self.numeric_index = {name: j for j, name in enumerate(numeric)}
        self.codes = codes
        self.values = values
        self.absent = absent
        self.work_dir = work_dir
        self.tag = tag
        self.block_rows = block_rows
        self._files = 0

    def _blocks(self, idx):
        idx = np.arange(self.n) if idx is None else np.asarray(idx, dtype=np.int64)
        for start in range(0, len(idx), self.block_rows):
            yield start, idx[start:start + self.block_rows]

    def columns(self, schema: dict, idx, exclude_groups):
        """Same specs as data.build_columns(schema, frame.iloc[idx], 'lightgbm'): a missing indicator when any NaN."""
        idx = np.asarray(idx, dtype=np.int64)
        has_nan = np.zeros(len(self.numeric_index), dtype=bool)
        for _, block in self._blocks(idx):
            has_nan |= np.isnan(self.raw[block]).any(axis=0) if len(block) else False
        columns: list[dict] = []
        for spec in schema['features']:
            if exclude_groups and spec['group'] in exclude_groups:
                continue
            name = spec['name']
            if spec['type'] == 'category':
                for value in spec['values']:
                    columns.append({'name': f'{name}={value}', 'feature': name, 'kind': 'onehot', 'category': value})
                continue
            columns.append({'name': name, 'feature': name, 'kind': 'value', 'transform': spec.get('transform')})
            missing = len(idx) > 0 if name in self.absent else bool(has_nan[self.numeric_index[name]])
            if missing:
                columns.append({'name': f'{name}__missing', 'feature': name, 'kind': 'missing'})
        return columns

    def _vectorize_block(self, block: np.ndarray, columns: list[dict]) -> np.ndarray:
        raw_block = self.raw[block] if len(block) else np.zeros((0, len(self.numeric_index)))
        out = np.zeros((len(block), len(columns)), dtype=float)
        for j, column in enumerate(columns):
            feature = column['feature']
            if column['kind'] == 'onehot':
                if feature in self.codes:
                    lookup = {value: code for code, value in enumerate(self.values[feature])}
                    code = lookup.get(column['category'], -1)
                    out[:, j] = (self.codes[feature][block] == code).astype(float) if code >= 0 else 0.0
                continue
            raw = np.full(len(block), np.nan) if feature in self.absent else raw_block[:, self.numeric_index[feature]]
            if column['kind'] == 'missing':
                out[:, j] = np.isnan(raw).astype(float)
                continue
            out[:, j] = _vectorize_values(raw, column.get('transform'))
        return out

    def matrix(self, columns: list[dict], idx) -> np.ndarray:
        """Rows `idx` vectorized (memmap file in the work directory when large: LightGBM reads it without a copy)."""
        idx = np.asarray(idx, dtype=np.int64)
        shape = (len(idx), len(columns))
        if shape[0] * shape[1] * 8 >= MEMMAP_MIN_BYTES:
            self._files += 1
            matrix = np.lib.format.open_memmap(self.work_dir / f'{self.tag}-matrix-{self._files}.npy', mode='w+', dtype=np.float64, shape=shape)
        else:
            matrix = np.zeros(shape, dtype=float)
        for start, block in self._blocks(idx):
            matrix[start:start + len(block)] = self._vectorize_block(block, columns)
        if isinstance(matrix, np.memmap):
            matrix.flush()
        return matrix

    def predict(self, model, columns: list[dict], idx=None) -> np.ndarray:
        parts = [model.predict(self._vectorize_block(block, columns), raw_score=True) for _, block in self._blocks(idx)]
        return np.concatenate(parts) if parts else np.zeros(0)

    def raw_rows(self, count: int) -> list[dict]:
        rows = []
        for i in range(min(count, self.n)):
            row = {}
            for name, j in self.numeric_index.items():
                row[name] = self.raw[i, j]
            for name, codes in self.codes.items():
                code = int(codes[i])
                text = None if code < 0 else self.values[name][code]
                row[name] = np.nan if text is None or text == 'nan' else text
            rows.append(row)
        return rows


def load_in_memory(directory: Path):
    """Original loader: the whole CSV as one DataFrame (small datasets / reference)."""
    manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
    frame = pd.read_csv(directory / 'dataset.csv', dtype=META_DTYPES, keep_default_na=True)
    frame = frame.sort_values(['snapshot_at_ms', 'row_id'], kind='mergesort').reset_index(drop=True)
    kinds = {kind: InMemoryKind(frame[(frame['kind'] == kind) & frame[label].notna()].reset_index(drop=True)) for kind, label in KIND_LABEL.items()}
    return kinds, manifest


def load_streaming(directory: Path, schema: dict, work_dir: Path, chunk_rows: int | None = None, block_rows: int | None = None):
    """Bounded-memory loader (see module docstring). Returns the same kinds / order as load_in_memory."""
    chunk_rows = chunk_rows or DEFAULT_CHUNK_ROWS
    block_rows = block_rows or DEFAULT_BLOCK_ROWS
    manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
    csv = directory / 'dataset.csv'
    header = list(pd.read_csv(csv, nrows=0).columns)
    meta_columns = [name for name in META_COLUMNS + LABEL_COLUMNS if name in header]
    meta = pd.concat([chunk for chunk in pd.read_csv(csv, usecols=meta_columns, dtype={k: v for k, v in META_DTYPES.items() if k in meta_columns}, keep_default_na=True, chunksize=chunk_rows)], ignore_index=True)
    meta = meta[[name for name in header if name in meta_columns]]
    total = len(meta)
    ordered = meta.sort_values(['snapshot_at_ms', 'row_id'], kind='mergesort')
    selections = {}
    for kind, label in KIND_LABEL.items():
        subset = ordered[(ordered['kind'] == kind) & ordered[label].notna()]
        position = np.full(total, -1, dtype=np.int64)
        position[subset.index.to_numpy()] = np.arange(len(subset))
        selections[kind] = (subset.reset_index(drop=True), position)
    del ordered
    features = [spec for spec in schema['features']]
    numeric = [spec['name'] for spec in features if spec['type'] != 'category' and spec['name'] in header]
    categories = [spec['name'] for spec in features if spec['type'] == 'category' and spec['name'] in header]
    absent = {spec['name'] for spec in features if spec['name'] not in header}
    raws, codes, values = {}, {}, {name: [] for name in categories}
    lookups = {name: {} for name in categories}
    for kind, (subset, _) in selections.items():
        raws[kind] = np.lib.format.open_memmap(work_dir / f'{kind.lower()}-raw.npy', mode='w+', dtype=np.float64, shape=(len(subset), len(numeric)))
        codes[kind] = {name: np.full(len(subset), -1, dtype=np.int32) for name in categories}
    offset = 0
    for chunk in pd.read_csv(csv, usecols=numeric + categories, dtype={name: str for name in categories}, keep_default_na=True, chunksize=chunk_rows):
        rows = np.arange(offset, offset + len(chunk))
        offset += len(chunk)
        numeric_block = np.column_stack([pd.to_numeric(chunk[name], errors='coerce').to_numpy(dtype=float) for name in numeric]) if numeric else np.zeros((len(chunk), 0))
        category_block = {}
        for name in categories:
            # Same text as series.astype(str) of the in-memory path (missing -> 'nan').
            texts = chunk[name].astype(str).to_numpy()
            lookup = lookups[name]
            block_codes = np.empty(len(texts), dtype=np.int32)
            for i, text in enumerate(texts):
                code = lookup.get(text)
                if code is None:
                    code = lookup[text] = len(values[name])
                    values[name].append(text)
                block_codes[i] = code
            category_block[name] = block_codes
        for kind, (_, position) in selections.items():
            target = position[rows]
            keep = target >= 0
            if not keep.any():
                continue
            raws[kind][target[keep]] = numeric_block[keep]
            for name in categories:
                codes[kind][name][target[keep]] = category_block[name][keep]
    for raw in raws.values():
        raw.flush()
    kinds = {kind: StreamingKind(subset, raws[kind], numeric, codes[kind], values, absent, work_dir, kind.lower(), block_rows) for kind, (subset, _) in selections.items()}
    return kinds, manifest
