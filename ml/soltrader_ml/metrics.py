"""Classification + trading-relevant metrics (accuracy alone is never reported as quality)."""
from __future__ import annotations

import math

import numpy as np
from sklearn.metrics import average_precision_score, brier_score_loss, confusion_matrix, f1_score, precision_score, recall_score, roc_auc_score

THRESHOLDS = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90]


def _safe(fn, *args, **kwargs):
    try:
        value = fn(*args, **kwargs)
        return None if value is None or (isinstance(value, float) and math.isnan(value)) else float(value)
    except ValueError:
        return None


def classification_metrics(y: np.ndarray, p: np.ndarray, threshold: float = 0.5) -> dict:
    pred = (p >= threshold).astype(int)
    two_classes = len(np.unique(y)) == 2
    matrix = confusion_matrix(y, pred, labels=[0, 1]).tolist() if len(y) else [[0, 0], [0, 0]]
    bins = np.linspace(0, 1, 11)
    calibration = []
    for low, high in zip(bins[:-1], bins[1:]):
        mask = (p >= low) & (p < high if high < 1 else p <= high)
        if mask.sum():
            calibration.append({'bin': f'{low:.1f}-{high:.1f}', 'n': int(mask.sum()), 'meanPredicted': float(p[mask].mean()), 'observedRate': float(y[mask].mean())})
    return {
        'n': int(len(y)),
        'positives': int(y.sum()),
        'positiveRate': float(y.mean()) if len(y) else None,
        'rocAuc': _safe(roc_auc_score, y, p) if two_classes else None,
        'prAuc': _safe(average_precision_score, y, p) if two_classes else None,
        'precision': _safe(precision_score, y, pred, zero_division=0),
        'recall': _safe(recall_score, y, pred, zero_division=0),
        'f1': _safe(f1_score, y, pred, zero_division=0),
        'brier': _safe(brier_score_loss, y, p) if len(y) else None,
        'confusionMatrix': matrix,
        'calibration': calibration,
        'predictionDistribution': {q: float(np.quantile(p, float(q))) for q in ['0.1', '0.25', '0.5', '0.75', '0.9']} if len(p) else {},
    }


def trading_stats(pnl: np.ndarray) -> dict:
    if not len(pnl):
        return {'trades': 0, 'wins': 0, 'netPnl': 0.0, 'profitFactor': None, 'expectancy': None, 'maxDrawdown': None, 'winRate': None}
    wins = pnl[pnl > 0]
    losses = pnl[pnl <= 0]
    equity = np.cumsum(pnl)
    peak = np.maximum.accumulate(np.concatenate([[0.0], equity]))[1:]
    return {
        'trades': int(len(pnl)), 'wins': int(len(wins)), 'netPnl': float(pnl.sum()),
        'profitFactor': float(wins.sum() / -losses.sum()) if losses.sum() < 0 else None,
        'expectancy': float(pnl.mean()), 'maxDrawdown': float((peak - equity).max()), 'winRate': float(len(wins) / len(pnl)),
    }


def threshold_curve(y: np.ndarray, p: np.ndarray, pnl: np.ndarray) -> list[dict]:
    """Per threshold: label metrics on all rows + PAPER-trade filter metrics on rows with a real trade (chronological)."""
    traded = ~np.isnan(pnl)
    baseline = trading_stats(pnl[traded])
    base_winners = int((pnl[traded] > 0).sum())
    base_losers = int((pnl[traded] <= 0).sum())
    rows = []
    for threshold in THRESHOLDS:
        selected = p >= threshold
        kept = traded & selected
        stats = trading_stats(pnl[kept])
        kept_winners = int((pnl[kept] > 0).sum())
        kept_losers = int((pnl[kept] <= 0).sum())
        rows.append({
            'threshold': threshold,
            'coverage': float(selected.mean()) if len(p) else None,
            'selected': int(selected.sum()),
            'precision': float(y[selected].mean()) if selected.sum() else None,
            'baseRate': float(y.mean()) if len(y) else None,
            'paper': {
                **stats,
                'winnerRetention': kept_winners / base_winners if base_winners else None,
                'loserRejection': (base_losers - kept_losers) / base_losers if base_losers else None,
                'baseline': baseline,
            },
        })
    return rows
