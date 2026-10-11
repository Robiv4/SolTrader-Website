# Machine Learning system (SHADOW)

**Principle:** record what was knowable at decision time for every eligible candidate, observe what happened
afterwards, train reproducible statistical models on chronological data, validate them out-of-sample, and run
predictions in **SHADOW** mode with zero influence on trading.

This is local, statistical ML. It is **not** the AI Trader: no LLM and no paid API are used anywhere in the pipeline.

Order of work: data quality first, validation second, shadow prediction third. PAPER enforcement is a future task;
LIVE is out of scope.

## Architecture

```
TRADING  Discovery -> Security -> Risk -> NewLaunch -> PAPER execution -> Exit engine        (unchanged)
                 \ copies (sync hooks, try/catch, never awaited)
LEARNING  MlShadowService: feature snapshot -> shadow outcome (trade stream) -> DB
          pnpm ml:dataset -> immutable dataset (CSV + manifest + hash)
          pnpm ml:train   -> Python: split / purge / walk-forward / LR + LightGBM -> JSON artifacts
          UI (admin + e-mail code) -> model status SHADOW -> worker loads artifact (hash verified)
          -> MlPrediction (stored, never acted upon)
```

| Part | Code |
| --- | --- |
| Feature schema + snapshot builder | `packages/strategy-engine/src/ml/features.ts` (`ML-FEATURES-v1`) |
| Outcomes / labels | `packages/strategy-engine/src/ml/outcomes.ts` (`ML-LABELS-v1`) |
| Dataset builder | `packages/strategy-engine/src/ml/dataset.ts` |
| Inference (TypeScript, JSON artifacts) | `packages/strategy-engine/src/ml/model.ts` |
| Worker shadow service | `apps/worker/src/ml/ml-shadow-service.ts` |
| CLI | `apps/worker/scripts/ml-cli.ts` |
| Python trainer | `ml/soltrader_ml/` (`data`, `split`, `models`, `metrics`, `train`, `synthetic`) |
| API / UI | `apps/api/src/ml-analytics.ts`, `/machine-learning` |

## Shadow isolation

- `NewLaunchService` gets an optional `ml` observer with five hooks: `attach`, `onTrade`, `onComplete`,
  `onEvaluation` and `onTick`.
  - Every call is synchronous and wrapped (`mlSafe`). Exceptions are counted, never propagated.
  - `onEvaluation` receives a copy of a decision that is already final.
- All ML database writes go through a bounded background queue (default 5,000). When it is full, writes are dropped
  and counted. A database failure is logged and counted; it never blocks the exit engine.
- The test `apps/worker/test/ml-shadow.test.ts` runs the same launch scenario three times and checks that the
  NewLaunch decisions and BUY signals are identical. The scenario includes a real BUY.
  1. without ML;
  2. with the real ML service;
  3. with an ML observer that throws on every call.
- Security, Risk, Sellability and Exit Capacity always outrank ML. ML can never turn a hard block into a BUY.

## Feature snapshot (`ML-FEATURES-v1`)

**Prediction points** (`kind`):

- `AGE_15S`, `AGE_30S` and `AGE_60S` after detection;
- `BUY_DECISION` at the moment of a BUY.

A point missed by more than 10 s (busy or restarted worker) is skipped, never back-dated.

**Eligibility** (independent of trading filters): a real price and at least 2 trades. Ineligible candidates are only
counted.

**Feature groups:** `SOURCE`, `AGE`, `MARKET`, `STRUCTURE`, `SECURITY`, `RISK`, `LAUNCH`, `SOCIAL`. The full list,
with descriptions and transforms, is `ML_FEATURE_SCHEMA`, exported to `ml/schema/features-v1.json` by
`pnpm ml:schema`.

**Feature notes:**

- The launch scores use the ML reference settings (`DEFAULT_NEW_LAUNCH_SETTINGS`). The actual per-user decisions are
  stored in `decisionContext` (users hashed).
- Holder features come from the trade stream (`largestHolderSupplyShare`, `creatorHoldingShare`). On-chain
  top-5 / top-10 holders are not collected in v1, because they would need extra RPC calls.
- Telegram features reuse the Social engine snapshot. No extra subscription and no historical backfill are made.

**Missing data:**

- Missing values are always `null`, never 0 and never 50. Booleans are true / false / null.
- The trainer adds explicit `__missing` indicator columns.
- Tree models receive NaN. Logistic regression imputes the training median.

**Immutability:** a snapshot is written once. Outcomes live in a separate table.

## Leakage prevention

- Every input series is cut at `snapshotAt`.
- Each feature group stores its `observedAt`. If `observedAt > snapshotAt`, the snapshot gets
  `validForTraining=false` with a `FUTURE_DATA_<group>` reason. Future social data is dropped; security data read
  later is nulled.
- Outcome data never enters feature columns (tested).
- One training row per candidate (the earliest snapshot of the configured kind), so near-identical rows of one launch
  cannot sit on both sides of a split.
- Developer / wallet grouping is not used: the creator wallet is known, but launch families are not verified.

## Shadow outcomes (`ML-LABELS-v1`)

**Data source:**

- Pump.fun: the same `logsSubscribe` trade stream NewLaunch already uses, so there are 0 extra RPC calls and 0 market
  data requests.
  - On a bonding curve the price only moves on trades, so "no trade" means "unchanged price" while the stream is
    healthy.
  - More than 15 s with no program-wide trade opens a stream gap. Horizons overlapping a gap are invalid.
- Raydium / Meteora: at most 1 market-data poll per minute per path, inside `ML_MAX_MARKET_DATA_PER_MIN` (default
  20). Missed polls become gaps.

**Path storage:** time buckets of 1 s for the first 2 min, 5 s up to 10 min and 15 s up to 60 min, each with high,
low, close, trade count and minimum liquidity. MFE and MAE are exact, and first-hit ordering is exact across buckets.

**Horizons:** 10 s, 30 s, 1 m, 2 m, 5 m, 10 m, 15 m, 30 m and 60 m. For each: `returnPct`, MFE, MAE,
highest / lowest price and time to MFE / MAE.

**Labels:**

- Event labels `reachedPlus{3..50}` and `reachedMinus{3..25}` within 30 min.
- Path labels: `plus10BeforeMinus10`, `plus20BeforeMinus10`, `plus20BeforeMinus15`, `plus25BeforeMinus20` and
  `plus50BeforeMinus20`.
  - If both thresholds are first hit in the same bucket, the label is `null` (UNKNOWN, never guessed).
  - If neither is hit within a full, gap-free window, the label is `false`.
  - An incomplete window gives `null`.

**Failure labels:**

| Label | Meaning |
| --- | --- |
| `liquidityCollapse` | Liquidity ≥ 70% below the snapshot within 30 min. |
| `rugLikeFailure` | Liquidity collapse **and** a creator sell after the snapshot. Price loss alone is never a "rug". |
| `extremeDrawdown` | MAE ≤ -50%. |
| `marketDataLost` | End of observation or a gap before 30 min. |
| `sellabilityFailureAfterEntry` | Always `null` in v1 (not observable without a real sell). |

**Quality:** COMPLETE (30 min valid), PARTIAL or INSUFFICIENT, plus `validHorizons`.

**Outcome kinds:** only `ML_OUTCOME_KINDS` get a path (default `AGE_30S,BUY_DECISION`; storage).

**Restart:** TRACKING rows are resumed and the downtime is recorded as a gap. Rows past 60 min are finalised.

**Budget:** at most `ML_MAX_TRACKED_CANDIDATES` (3,000) concurrent paths. Beyond that the outcome is INSUFFICIENT
(`TRACKING_BUDGET_EXHAUSTED`); trading is unaffected.

## Dataset (`pnpm ml:dataset`)

**Input:**

- `ML-FEATURES-v1` snapshots of one kind (default `AGE_30S`);
- finished outcomes;
- the target (default `plus20BeforeMinus10_30m`).

**Exclusions** are counted per reason: `INVALID_FOR_TRAINING`, `DUPLICATE_CANDIDATE`, `NO_OUTCOME`,
`OUTCOME_INCOMPLETE`, `LABEL_AMBIGUOUS`, `LOW_DATA_QUALITY`, etc.

**Output:** `ml/datasets/<version>/dataset.csv` plus `manifest.json`, and an `MlDatasetVersion` row with the
SHA-256 hash. Versions are immutable.

**Manifest contents:**

- BUY / WATCH / REJECT counts and source distribution;
- missing rates and outcome quality;
- positives and negatives;
- leakage violations;
- readiness (guidance only): `< 1,000` usable rows or `< 50` positives is INSUFFICIENT_DATA; `< 5,000` or `< 200`
  is RESEARCH_ONLY.

**Determinism:** rows are ordered by (snapshotAt, id), columns follow the schema and values are written raw. Same
input gives the same CSV (tested).

**`paper_net_pnl`:** the realised net P&L (fees and slippage included) of the actual PAPER trade, joined by mint for
BUY candidates. It is used only by the trading simulation and is never a feature.

## Training (`pnpm ml:train`, Python 3.12, CPU)

1. **Data-quality gate.** These block training (exit code 3, no model):
   - fewer than 300 rows, or fewer than 30 positives or 30 negatives;
   - invalid or unordered timestamps;
   - duplicates;
   - a label window ending before the snapshot.
2. **Chronological split, 70 / 15 / 15.** **Purge:** a training row whose label window (snapshot + 30 min) reaches
   the validation start minus the embargo (default 60 s) is dropped; the same rule applies between validation and
   test. Candidate groups are asserted disjoint.
3. **Models.**
   - Logistic regression (baseline): `class_weight=balanced`, C=0.5, median imputation, standardisation.
   - LightGBM: 200 rounds, 15 leaves, depth 5, `is_unbalance`, deterministic, one thread. No large hyperparameter
     search.
   - Seeds are fixed and package versions are recorded.
4. **Calibration:** Platt scaling on **validation** data only, never on test. Without calibration the UI calls the
   output an "ML score", not a probability.
5. **Metrics.** For train / validation / untouched test:
   - ROC-AUC, PR-AUC, precision, recall, F1;
   - confusion matrix, Brier score, calibration bins;
   - prediction distribution and base rate.
6. **Threshold curve (0.50–0.90):**
   - coverage, precision and base rate;
   - a PAPER-trade filter on real trades: trades, winner retention, loser rejection, profit factor, expectancy and
     max drawdown.
7. **Walk-forward:** 4 expanding folds with purge; per-fold metrics and top features (stability over time).
8. **Overfitting and readiness.** `OVERFITTING_RISK` when train AUC − test AUC > 0.10, or train > 0.70 and
   test < 0.55. Readiness levels:
   - INSUFFICIENT_DATA;
   - RESEARCH_ONLY;
   - SHADOW_READY: test AUC ≥ 0.60, no overfitting, walk-forward AUC std < 0.08;
   - PAPER_EXPERIMENT_ELIGIBLE: never set automatically.
9. **Diagnostics:**
   - Feature importance: logistic |coef|, and LightGBM TreeSHAP (`pred_contrib`) on test. Importance is not
     causality.
   - Social ablation: test AUC with and without the SOCIAL features.
   - Per-source metrics only where n ≥ 50.
10. **Artifacts.** JSON only, no pickle: `ml/models/<version>/model.json`, `metadata.json` and `parity.json`.
    - The exported trees and coefficients are re-scored in Python and must equal the library within 1e-6.
    - The TypeScript parity test checks TS predictions against Python to 9 decimal places.

## Shadow predictor and promotion

- Statuses: `TRAINED`, `VALIDATED`, `SHADOW` and `RETIRED`. PAPER use is a separate, revocable approval
  (`paperApproved`), see "ML PAPER strategy" below; the `PAPER_*` status values are not used.
- Status changes are admin-only on the Machine Learning page, confirmed with an e-mail code and audited. Only one
  model can be SHADOW at a time. There is no automatic promotion and no automatic retraining.
- The worker loads the SHADOW model every 5 minutes:
  - the path must be inside `ml/models`;
  - the SHA-256 must equal the database hash;
  - the schema is validated.

  Any failure makes ML `UNAVAILABLE`; trading is unchanged.
- Predictions are stored as `MlPrediction` rows: probability, calibrated flag, `mlEntryScore` 0–100, `ML_BUY` /
  `ML_SKIP`, data quality, latency, and the top contributions for logistic models.

## ML PAPER strategy (selectable, PAPER only)

A user can select which strategy makes New Launch PAPER entries: **DEFAULT** (rule-based, the default) or **ML** (an
admin-approved model). LIVE is unreachable from this feature: ML entries go through the PAPER execution engine only,
`POST /api/safety/live/enable` is refused while ML is selected, and ML cannot be selected unless the account and the
server run in PAPER.

**Approval (`POST /api/ml/models/:version/paper-approval`, admin + e-mail code).** `SHADOW_READY` alone grants nothing.
Required: status VALIDATED or SHADOW, readiness SHADOW_READY, current feature version, the model has run in SHADOW and
has at least 100 stored shadow predictions, its dataset snapshot kind is a supported prediction point, and the artifact
sha256 matches. `DELETE` revokes (admin); RETIRED also revokes. Approval never switches anybody to ML.

**Selection (`PUT /api/settings/ml-paper`).** Enabling ML or changing the model: administrator + e-mail code, approved
model, PAPER mode. Threshold 0.50-0.90, decision window 2-30 s. Back to DEFAULT: always allowed for the owner.

**Timing.** The model decides exactly once per user and candidate, at the snapshot point it was trained on (e.g.
AGE_30S = detection + 30 s, tolerance 10 s), from the features known at that moment (same builder as the SHADOW
collection). A candidate seen after the point is skipped, never decided late; a decision is never re-made with later
data. An ML BUY can only be executed after the decision, inside the window, once every mandatory safety check is green.

**Safety.** The model replaces only the strategic reasons (score / activity thresholds, exhaustion). Mandatory in ML
mode: security hard blocks, sellability (honeypot), authorities, critical extensions, creator selling, liquidity
minimum / maximum / critical drop, price impact, risk score and classification, launch window, quality gate and social
ENFORCE filters; then the PAPER engine's position size, open positions, exposure, daily loss, emergency stop and exit
capacity. Exits use the common exit engine (SL / TP / trailing) and never depend on the model.

**Fail-closed.** Missing / revoked / retired model, hash or version mismatch, missing feature, leakage, failed or invalid
inference, an unwritable decision row: `ML_ERROR`, no entry, and no automatic fallback to the rule-based strategy.

**Exactly one strategy buys.** In ML mode the rule-based BUY creates no signal (its decision is still logged for
comparison); at execution the signal's strategy (and for ML the selected, approved model) must still be active.

**Audit (`MlPaperDecision`, one row per user and candidate).** Model / feature version, snapshot kind and time, the exact
features + hash, probability, threshold, ML_BUY / ML_SKIP / ML_ERROR, the rule-based decision, safety blockers and the
execution result (SIGNALED, EXECUTED, EXECUTION_REJECTED, SAFETY_BLOCKED, EXPIRED). Trades and positions store
`entryStrategy` (DEFAULT | ML), trades also `mlModelVersion` and `mlPaperDecisionId`; existing New Launch trades were
migrated to DEFAULT. A later model or strategy change never rewrites them.

**Training data (task 12).** SHADOW collection runs for every candidate in both modes. Datasets join the real PAPER
result of candidates bought by either strategy (provenance only, never a feature). `paperNetPositive` is a separate
research target from real closed PAPER trades only (`selectionBiased: true`, label end = trade exit); skipped candidates
never get an invented P&L. New models are never activated automatically.

## Analytics (/machine-learning)

The page has these sections:

- overview, dataset versions and models;
- shadow predictions with the future outcome;
- SolTrader × ML matrix;
- missed opportunities (shown with the rejection reason) and bad entries;
- Launch Score × ML, entry age × ML, Telegram × ML and per source;
- drift: recent 24 h medians and missing rates vs the model's training period (`MODEL_DATA_DRIFT`), and recent
  AUC vs validation AUC (`MODEL_PERFORMANCE_DRIFT`);
- worker system metrics.

Everything is labelled HISTORICAL / SHADOW / PAPER RESEARCH, and small samples are flagged.

## Resource budget and observability

- **Additional RPC requests:** 0. ML performs no Solana reads; security data is reused from NewLaunch.
- **Additional market data:** only for non-stream sources (Raydium / Meteora), budgeted.
- **`ml:health` (Redis, every 10 s):**
  - candidates seen, eligible and ineligible;
  - snapshots, missed points and leakage violations;
  - tracked paths and tracking started / dropped / completed;
  - stream gaps;
  - predictions, failures and inference / snapshot latency P50 / P95;
  - write queue depth, failures and drops;
  - extra RPC and market-data requests.
- **Daily counters:** `ml:stats:<day>:snapshots|outcomesCompleted`.

## Historical data

Existing `LaunchSnapshot` observations cover only the launch window (median 30 s, at most ~90 s). There is no 30-min
path for non-traded candidates, and old Telegram features cannot be reconstructed. They are therefore **not**
imported into `ML-FEATURES-v1` datasets. Collection starts with the first worker run after this change.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm ml:setup` | Python 3.12 x64 venv in `ml/.venv` + pinned requirements |
| `pnpm ml:schema` | Export the feature schema for Python |
| `pnpm ml:status` | Collection / model status |
| `pnpm ml:dataset --target plus20BeforeMinus10_30m --kind AGE_30S --min-quality 50` | Build a dataset |
| `pnpm ml:train [--dataset NL-DATASET-v1] [--seed 42]` | Train and register models as TRAINED |
| `pnpm ml:test` | Python tests (synthetic data) |

**Windows setup:** install Python 3.12 **64-bit** from python.org. Per-user install is fine and PATH is not needed;
the default `%LOCALAPPDATA%\Programs\Python\Python312` path is used. Then run `pnpm ml:setup`. The 32-bit or beta
Python found on PATH cannot install scikit-learn or LightGBM.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ML_MODE` | `SHADOW` | `OFF` / `SHADOW`. `ENFORCE_PAPER` falls back to SHADOW. |
| `ML_MAX_TRACKED_CANDIDATES` | 3000 | Concurrent outcome paths |
| `ML_MAX_MARKET_DATA_PER_MIN` | 20 | Polling budget for non-stream sources |
| `ML_OUTCOME_KINDS` | `AGE_30S,BUY_DECISION` | Snapshot kinds with an outcome path |

## Known limitations (v1)

- Real model quality cannot be judged until enough outcomes exist: several days of collection with the worker
  running.
- After a bonding curve migrates (PumpSwap / Raydium) the stream price ends, so the outcome is cut (`MIGRATED`,
  `marketDataLost`).
- On-chain holder distribution (top-5 / top-10) is not a v1 feature.
- `sellabilityFailureAfterEntry` cannot be observed without real sells.
- The trading simulation only covers candidates that were actually bought. It filters real PAPER trades and does not
  simulate fills for unbought candidates.
