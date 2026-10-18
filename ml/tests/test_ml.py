"""Python ML tests (synthetic data only)."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np
import pytest

from soltrader_ml.data import build_columns, load_dataset, load_schema, transform, vectorize
from soltrader_ml.split import assert_disjoint_groups, chronological_split, walk_forward
from soltrader_ml.synthetic import make_synthetic_dataset
from soltrader_ml.train import main as train_main

ROOT = Path(__file__).resolve().parents[2]


def test_temporal_split_never_puts_future_rows_in_training_and_purges_overlapping_labels():
    times = np.arange(0, 100_000, 1_000, dtype=np.int64)
    label_end = times + 5_000  # each label looks 5 s ahead
    split = chronological_split(times, label_end, embargo_ms=0)
    assert times[split.train].max() < times[split.validation].min() <= times[split.test].min()
    # Purge: no training label window reaches into validation; no validation label reaches into test.
    assert (label_end[split.train] <= split.boundaries['validationStartMs']).all()
    assert (label_end[split.validation] <= split.boundaries['testStartMs']).all()
    # A label ending exactly at the boundary does not overlap it: 4 purged rows per boundary (5 s horizon, 1 s spacing).
    assert split.purged['train'] == 4 and split.purged['validation'] == 4
    with_embargo = chronological_split(times, label_end, embargo_ms=10_000)
    assert with_embargo.purged['train'] == 14


def test_walk_forward_folds_are_chronological_and_purged():
    times = np.arange(0, 200_000, 1_000, dtype=np.int64)
    label_end = times + 3_000
    folds = walk_forward(times, label_end, folds=4)
    assert len(folds) == 4
    for fold in folds:
        assert times[fold['train']].max() < fold['testStartMs']
        assert (label_end[fold['train']] <= fold['testStartMs']).all()
    assert [len(f['train']) for f in folds] == sorted(len(f['train']) for f in folds)


def test_group_leakage_is_detected():
    groups = np.array(['a', 'b', 'c', 'a'])
    with pytest.raises(AssertionError):
        assert_disjoint_groups(groups, np.array([0, 1]), np.array([2, 3]))
    assert_disjoint_groups(groups, np.array([0, 1]), np.array([2]))


def test_transforms_match_typescript_definitions():
    assert transform(-5.0, 'log1p') == 0.0
    assert transform(9.0, 'log1p') == pytest.approx(np.log1p(9.0))
    assert transform(-9.0, 'signed_log1p') == pytest.approx(-np.log1p(9.0))
    assert transform(0.0, 'signed_log1p') == 0.0


def test_missing_values_are_not_zero_filled_for_trees(tmp_path):
    directory = make_synthetic_dataset(tmp_path / 'ds', rows=200)
    frame, _ = load_dataset(directory)
    schema = load_schema()
    columns = build_columns(schema, frame, 'lightgbm')
    x = vectorize(frame, columns, 'lightgbm')
    social = [i for i, c in enumerate(columns) if c['feature'] == 'telegramMomentum' and c['kind'] == 'value'][0]
    indicator = [i for i, c in enumerate(columns) if c['feature'] == 'telegramMomentum' and c['kind'] == 'missing'][0]
    assert np.isnan(x[:, social]).any()
    assert (x[np.isnan(x[:, social]), indicator] == 1).all()


def test_quality_gate_refuses_tiny_dataset(tmp_path):
    directory = make_synthetic_dataset(tmp_path / 'tiny', rows=100)
    assert train_main(['--dataset', str(directory), '--out', str(tmp_path / 'models')]) == 3
    assert not list((tmp_path / 'models').glob('ML-*'))


def _train(tmp_path, name):
    directory = make_synthetic_dataset(tmp_path / f'ds-{name}', rows=1200, seed=7)
    out = tmp_path / f'models-{name}'
    assert train_main(['--dataset', str(directory), '--out', str(out), '--seed', '42']) == 0
    return out


def test_training_is_reproducible_and_exports_reproduce_library_scores(tmp_path):
    first = _train(tmp_path, 'a')
    second = _train(tmp_path, 'b')
    for algorithm in ['LR', 'LGBM']:
        meta_a = json.loads(next(first.glob(f'ML-{algorithm}-*/metadata.json')).read_text())
        meta_b = json.loads(next(second.glob(f'ML-{algorithm}-*/metadata.json')).read_text())
        assert meta_a['artifactHash'] == meta_b['artifactHash']
        assert meta_a['metrics']['test']['rocAuc'] == meta_b['metrics']['test']['rocAuc']
        assert meta_a['exportParityMaxDiff'] <= 1e-6
        # Synthetic data has real signal: the models must find it out-of-sample.
        assert meta_a['metrics']['test']['rocAuc'] > 0.7
        assert meta_a['readiness'] in {'INSUFFICIENT_DATA', 'RESEARCH_ONLY'}
        assert len(meta_a['walkForward']) == 4
        assert meta_a['split']['purged']['train'] >= 0
    # Fixture for the TypeScript parity test (same artifact + expected probabilities).
    fixture = {}
    for algorithm in ['LR', 'LGBM']:
        model_dir = next(first.glob(f'ML-{algorithm}-*'))
        fixture[algorithm] = {'artifact': json.loads((model_dir / 'model.json').read_text()), 'rows': json.loads((model_dir / 'parity.json').read_text())[:20]}
    target = ROOT / 'packages' / 'strategy-engine' / 'test' / 'fixtures' / 'ml-parity.json'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(fixture), encoding='utf-8')


def test_community_feature_version_trains_with_its_own_schema_and_name(tmp_path):
    # SYNTHETIC smoke test of the pipeline only: says nothing about real community-model performance.
    directory = make_synthetic_dataset(tmp_path / 'ds-community', rows=1200, seed=7, feature_version='ML-FEATURES-COMMUNITY-v1', version='COMMUNITY-v1')
    out = tmp_path / 'models-community'
    assert train_main(['--dataset', str(directory), '--out', str(out), '--seed', '42']) == 0
    meta = json.loads((out / 'ML-LGBM-COMMUNITY-v1-s42' / 'metadata.json').read_text())
    assert meta['featureVersion'] == 'ML-FEATURES-COMMUNITY-v1'
    assert meta['status'] == 'TRAINED'
    assert meta['readiness'] in {'INSUFFICIENT_DATA', 'RESEARCH_ONLY'}
    assert 'testRocAucWithoutCommunity' in meta['socialAblation']
    artifact = json.loads((out / 'ML-LGBM-COMMUNITY-v1-s42' / 'model.json').read_text())
    assert artifact['featureVersion'] == 'ML-FEATURES-COMMUNITY-v1'
    assert any(column['feature'] == 'communityScore' for column in artifact['columns'])


def test_unknown_feature_version_is_refused():
    import pytest
    from soltrader_ml.data import load_schema
    with pytest.raises(SystemExit):
        load_schema(feature_version='ML-FEATURES-v999')
