"""Chronological splitting with purge / embargo, and walk-forward folds.

Rows are ordered by snapshot time. Each row's label depends on data up to `label_end_ms` (snapshot + outcome horizon).
Purge: a training row whose outcome window reaches into the next block (label_end > next block start - embargo) is
dropped, so no training label "knows" prices that the evaluation period is graded on. The same rule is applied
between validation and test. One row per candidate is enforced by the dataset builder (group leakage), and
`assert_disjoint_groups` double-checks it.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class Split:
    train: np.ndarray
    validation: np.ndarray
    test: np.ndarray
    boundaries: dict
    purged: dict


def chronological_split(times: np.ndarray, label_end: np.ndarray, fractions=(0.70, 0.15, 0.15), embargo_ms: int = 0) -> Split:
    n = len(times)
    if n < 3:
        raise ValueError('Too few rows to split')
    if np.any(np.diff(times) < 0):
        raise ValueError('Rows must be ordered by time')
    train_end = int(n * fractions[0])
    val_end = int(n * (fractions[0] + fractions[1]))
    val_start_t = times[train_end]
    test_start_t = times[val_end]
    idx = np.arange(n)
    train_mask = (idx < train_end) & (label_end <= val_start_t - embargo_ms)
    val_mask = (idx >= train_end) & (idx < val_end) & (label_end <= test_start_t - embargo_ms)
    test_mask = idx >= val_end
    return Split(
        train=idx[train_mask], validation=idx[val_mask], test=idx[test_mask],
        boundaries={'validationStartMs': int(val_start_t), 'testStartMs': int(test_start_t), 'embargoMs': int(embargo_ms)},
        purged={'train': int(train_end - train_mask.sum()), 'validation': int((val_end - train_end) - val_mask.sum())},
    )


def walk_forward(times: np.ndarray, label_end: np.ndarray, folds: int = 4, min_train_fraction: float = 0.4, embargo_ms: int = 0):
    """Expanding window: TRAIN | TEST, then TRAIN grows to include the previous test block."""
    n = len(times)
    start = int(n * min_train_fraction)
    block = max(1, (n - start) // folds)
    result = []
    for fold in range(folds):
        test_from = start + fold * block
        test_to = n if fold == folds - 1 else min(n, test_from + block)
        if test_from >= n:
            break
        test_start_t = times[test_from]
        idx = np.arange(n)
        train = idx[(idx < test_from) & (label_end <= test_start_t - embargo_ms)]
        test = idx[test_from:test_to]
        result.append({'fold': fold + 1, 'train': train, 'test': test, 'testStartMs': int(test_start_t), 'purged': int(test_from - len(train))})
    return result


def assert_disjoint_groups(groups: np.ndarray, *parts: np.ndarray):
    seen: set = set()
    for part in parts:
        current = set(groups[part].tolist())
        overlap = seen & current
        if overlap:
            raise AssertionError(f'Group leakage across splits: {sorted(overlap)[:5]}')
        seen |= current
