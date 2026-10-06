"""Model training + export to the TypeScript artifact format (soltrader-ml-model-v1). No pickle is ever written."""
from __future__ import annotations

import math

import lightgbm as lgb
import numpy as np
from sklearn.linear_model import LogisticRegression

ARTIFACT_FORMAT = 'soltrader-ml-model-v1'

LOGISTIC_PARAMS = {'C': 0.5, 'class_weight': 'balanced', 'max_iter': 5000, 'solver': 'lbfgs'}
# Conservative, small trees (small datasets): no large hyper-parameter search.
LIGHTGBM_PARAMS = {
    'objective': 'binary', 'learning_rate': 0.05, 'num_leaves': 15, 'max_depth': 5, 'min_data_in_leaf': 20,
    'feature_fraction': 0.8, 'bagging_fraction': 0.8, 'bagging_freq': 1, 'lambda_l2': 1.0, 'is_unbalance': True,
    'verbosity': -1, 'deterministic': True, 'force_row_wise': True, 'num_threads': 1, 'use_missing': True,
}
LIGHTGBM_ROUNDS = 200


def train_logistic(x: np.ndarray, y: np.ndarray, seed: int):
    model = LogisticRegression(random_state=seed, **LOGISTIC_PARAMS)
    model.fit(x, y)
    return model


def train_lightgbm(x: np.ndarray, y: np.ndarray, seed: int, rounds: int = LIGHTGBM_ROUNDS):
    params = {**LIGHTGBM_PARAMS, 'seed': seed, 'bagging_seed': seed, 'feature_fraction_seed': seed, 'data_random_seed': seed,
              'min_data_in_leaf': max(LIGHTGBM_PARAMS['min_data_in_leaf'], int(len(y) * 0.01))}
    return lgb.train(params, lgb.Dataset(x, label=y, free_raw_data=False), num_boost_round=rounds)


def raw_score(algorithm: str, model, x: np.ndarray) -> np.ndarray:
    if algorithm == 'logistic_regression':
        return model.decision_function(x)
    return model.predict(x, raw_score=True)


def sigmoid(value):
    return 1.0 / (1.0 + np.exp(-value))


def fit_platt(raw_validation: np.ndarray, y_validation: np.ndarray):
    """Platt scaling on VALIDATION data only (never test). None when validation has a single class."""
    if len(np.unique(y_validation)) < 2:
        return None
    model = LogisticRegression(C=1e6, max_iter=5000)
    model.fit(raw_validation.reshape(-1, 1), y_validation)
    return {'method': 'platt', 'a': float(model.coef_[0][0]), 'b': float(model.intercept_[0])}


def probability(raw: np.ndarray, calibration: dict | None) -> np.ndarray:
    if calibration:
        return sigmoid(calibration['a'] * raw + calibration['b'])
    return sigmoid(raw)


def export_artifact(algorithm: str, model, columns: list[dict], meta: dict, calibration: dict | None, threshold: float) -> dict:
    artifact = {
        'format': ARTIFACT_FORMAT,
        'modelVersion': meta['modelVersion'],
        'algorithm': algorithm,
        'featureVersion': meta['featureVersion'],
        'labelVersion': meta['labelVersion'],
        'target': meta['target'],
        'columns': columns,
        'calibration': calibration,
        'decisionThreshold': threshold,
    }
    if algorithm == 'logistic_regression':
        artifact['logistic'] = {'coef': [float(v) for v in model.coef_[0]], 'intercept': float(model.intercept_[0])}
    else:
        dump = model.dump_model()
        artifact['lightgbm'] = {'trees': [{'tree_structure': tree['tree_structure']} for tree in dump['tree_info']]}
    return artifact


def _eval_tree(node: dict, x: np.ndarray) -> float:
    """Python mirror of evalTree() in model.ts (used to prove exported trees == LightGBM)."""
    while 'leaf_value' not in node:
        value = x[node['split_feature']]
        missing = node.get('missing_type', 'None')
        if missing == 'NaN' and math.isnan(value):
            left = bool(node.get('default_left'))
        elif missing == 'Zero' and (math.isnan(value) or abs(value) <= 1e-35):
            left = bool(node.get('default_left'))
        else:
            if math.isnan(value):
                value = 0.0
            left = value <= node['threshold']
        node = node['left_child'] if left else node['right_child']
    return float(node['leaf_value'])


def artifact_raw_score(artifact: dict, x: np.ndarray) -> np.ndarray:
    if artifact['algorithm'] == 'logistic_regression':
        coef = np.array(artifact['logistic']['coef'])
        return x @ coef + artifact['logistic']['intercept']
    return np.array([sum(_eval_tree(tree['tree_structure'], row) for tree in artifact['lightgbm']['trees']) for row in x])
