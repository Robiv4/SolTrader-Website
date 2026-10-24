"""Streaming (bounded-memory) trainer path == original in-memory path (synthetic data only)."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from soltrader_ml import autonomous_data
from soltrader_ml.autonomous import main as autonomous_main
from soltrader_ml.autonomous_data import load_in_memory, load_streaming
from soltrader_ml.data import load_schema
from soltrader_ml.synthetic import make_autonomous_dataset

# artifactHash covers bundle.json including its createdAt timestamp.
VOLATILE = {'createdAt', 'trainedAt', 'packages', 'artifactHash'}


def _strip(value):
    if isinstance(value, dict):
        return {key: _strip(item) for key, item in value.items() if key not in VOLATILE}
    if isinstance(value, list):
        return [_strip(item) for item in value]
    return value


def _train(directory: Path, out: Path, *extra: str):
    assert autonomous_main(['--dataset', str(directory), '--out', str(out), '--seed', '42', *extra]) == 0
    model_dir = out / 'ML-AUTO-AUTO-SYNTHETIC-s42'
    return json.loads((model_dir / 'bundle.json').read_text()), json.loads((model_dir / 'metadata.json').read_text())


def test_streaming_loader_matches_in_memory_rows_columns_and_matrices(tmp_path, monkeypatch):
    directory = make_autonomous_dataset(tmp_path / 'ds', rows=1500, seed=5)
    schema = load_schema(feature_version='ML-FEATURES-AUTONOMOUS-v1')
    reference, _ = load_in_memory(directory)
    work = tmp_path / 'work'
    work.mkdir()
    # Tiny chunks / blocks: every batch boundary is crossed many times.
    streamed, _ = load_streaming(directory, schema, work, chunk_rows=97, block_rows=41)
    for kind in ['ENTRY', 'POSITION']:
        a, b = reference[kind], streamed[kind]
        assert a.n == b.n
        assert a.meta['row_id'].tolist() == b.meta['row_id'].tolist()
        assert a.meta['group_id'].tolist() == b.meta['group_id'].tolist()
        idx = np.arange(0, a.n, 2)
        cols_a, cols_b = a.columns(schema, idx, {'PORTFOLIO'}), b.columns(schema, idx, {'PORTFOLIO'})
        assert cols_a == cols_b
        monkeypatch.setattr(autonomous_data, 'MEMMAP_MIN_BYTES', 1)  # force the memory-mapped matrix path
        np.testing.assert_array_equal(a.matrix(cols_a, idx), b.matrix(cols_b, idx))


def test_streaming_trainer_produces_the_identical_bundle(tmp_path, monkeypatch):
    directory = make_autonomous_dataset(tmp_path / 'ds', rows=2400, seed=11)
    bundle_a, meta_a = _train(directory, tmp_path / 'in-memory', '--in-memory')
    monkeypatch.setattr(autonomous_data, 'DEFAULT_CHUNK_ROWS', 333)
    monkeypatch.setattr(autonomous_data, 'DEFAULT_BLOCK_ROWS', 177)
    monkeypatch.setattr(autonomous_data, 'MEMMAP_MIN_BYTES', 1)
    work = tmp_path / 'work'
    work.mkdir()
    bundle_b, meta_b = _train(directory, tmp_path / 'streaming', '--work-dir', str(work))
    assert _strip(bundle_a) == _strip(bundle_b)
    assert _strip(meta_a) == _strip(meta_b)
    # Matrix files are released after each fit; only the raw arrays remain in the caller's own work directory.
    assert sorted(path.name for path in work.iterdir()) == ['entry-raw.npy', 'position-raw.npy']


def test_trainer_removes_its_own_default_work_directory(tmp_path):
    directory = make_autonomous_dataset(tmp_path / 'ds', rows=2400, seed=11)
    out = tmp_path / 'models'
    _train(directory, out)
    assert sorted(path.name for path in out.iterdir()) == ['ML-AUTO-AUTO-SYNTHETIC-s42']


def test_existing_bundle_version_is_never_overwritten(tmp_path):
    directory = make_autonomous_dataset(tmp_path / 'ds', rows=2400, seed=11)
    out = tmp_path / 'models'
    _train(directory, out)
    before = {path.name: path.read_bytes() for path in (out / 'ML-AUTO-AUTO-SYNTHETIC-s42').iterdir()}
    assert autonomous_main(['--dataset', str(directory), '--out', str(out), '--seed', '42']) == 4
    assert {path.name: path.read_bytes() for path in (out / 'ML-AUTO-AUTO-SYNTHETIC-s42').iterdir()} == before


@pytest.mark.parametrize('rows', [2400])
def test_streaming_peak_memory_is_below_in_memory(tmp_path, rows):
    """Python-side memory: tracemalloc peak of the loader (numpy buffers are traced) - streaming keeps no full frame."""
    import tracemalloc
    directory = make_autonomous_dataset(tmp_path / 'ds', rows=rows, seed=7)
    schema = load_schema(feature_version='ML-FEATURES-AUTONOMOUS-v1')
    tracemalloc.start()
    load_in_memory(directory)
    _, peak_in_memory = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    work = tmp_path / 'work'
    work.mkdir()
    tracemalloc.start()
    load_streaming(directory, schema, work, chunk_rows=200)
    _, peak_streaming = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert peak_streaming < peak_in_memory
