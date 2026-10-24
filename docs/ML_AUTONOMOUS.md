# Autonomous ML trading engine (SolTrader 3.0, strategy `ML_AUTONOMOUS`)

PAPER only (`TRADING_MODE=PAPER`, `LIVE_TRADING_ENABLED=false`). The engine has no wallet and no order router. Nothing
is activated, approved, selected or replaced automatically. The existing DEFAULT / ML PAPER paths and their open
positions are unchanged.

## Architecture

```
New Launch tracker ─┬─ ML SHADOW (v1 / Community snapshots + 60 min outcome paths)   [unchanged]
                    └─ AutonomousEngine (apps/worker/src/autonomous/engine.ts, 2 s timer)
                         ├─ collection: ENTRY decision snapshots (all launches)  ──► MlAutonomousDecisionSnapshot
                         ├─ entries: bundle BUY / WAIT / SKIP + size ─► protection ─► virtual PAPER ledger
                         ├─ positions: fail-safes ─► bundle HOLD / PARTIAL_SELL / SELL ─► ledger
                         └─ SHADOW bundle: same decisions, never executed     ──► MlAutonomousDecision (mode SHADOW)
```

**Bundle** (`soltrader-autonomous-bundle-v1`, `packages/strategy-engine/src/autonomous/bundle.ts`): one immutable,
versioned file (`ml/autonomous-models/<version>/bundle.json`, sha256 in the registry). The user only ever selects this
one package.

| Component | Type | Learns |
| --- | --- | --- |
| `entryReturn` | LightGBM regression (Huber) | expected net return of an entry over 10 min (fees + impact) |
| `entryDownside` | LightGBM regression | expected worst net result inside the horizon |
| `entryProfit` | LightGBM binary + Platt | P(net > 0) |
| `exitAdvantage` | LightGBM regression | expected net advantage of holding 2 min vs selling now |
| `exitHold` | LightGBM binary + Platt | P(holding beats selling now) |

- **Policy:** the BUY / WAIT / SKIP and HOLD / PARTIAL_SELL / SELL thresholds are chosen by the trainer on validation data, by the realised net result. They are stored in the bundle. No DEFAULT momentum / score / TP / trailing threshold is used.
- **Sizing (v1):** a deterministic policy over the model outputs (edge vs downside, calibrated confidence) and the PAPER impact model. It is **not** a separately learned model yet; see "Known limitations".

## Mandatory protection (`protection.ts`, never strategic)

- **Entries:**
  - token fraud / honeypot / sellability / authority / Token-2022 / liquidity / impact / risk checks (`mlEntrySafetyBlockers` with default safety limits and ML minimum liquidity 3000 USD);
  - PAPER mode, no LIVE, emergency stop, fresh quote (≤ 15 s), one position per token, maximum open positions, position size, exposure, daily loss, impact limit.

  The stricter of the autonomous defaults and the user's RiskConfig applies. Protection can only block or reduce.
- **Exits (fail-safe, model-independent):** hard maximum loss (35 %), liquidity collapse (−60 %), lost sell route, technical maximum hold (120 min). A forced exit without a fresh real price waits; it never sells at an invented price.
- **Model failure:** no BUY (decision `ERROR`); open positions are protected by the fail-safes only (never DEFAULT exit rules). Open positions stay bound to their original bundle version.

## Data structures (migration `20261022144637_autonomous_ml`, additive only)

- `MlAutonomousModelBundle`: versioned bundle registry (status, readiness, policy, metrics, hash, approval).
- `MlAutonomousDecisionSnapshot`: time-correct ENTRY / POSITION feature rows (`observedAt` per group, `featureHash`).
- `MlAutonomousOutcome`: AUTO-LABELS-v1 label audit (labels, uncertainty, exclusion reason).
- `MlAutonomousDecision`: every decision. It stores the bundle version, action, model outputs, suggested and executed size, feature hash, snapshot, decision time, execution status, safety blockers and position. `idempotencyKey` is unique: one decision per decision point, so restarts and duplicate ticks cannot double an order.
- `MlAutonomousAccount` / `MlAutonomousPosition` / `MlAutonomousFill`: the separate virtual PAPER ledger (`accountKey = ML_AUTONOMOUS_PAPER:<userId>`). `openKey` is unique while a position is open; sells are conditional updates.
- `MlPaperSettings.autonomousBundleVersion` (+ `strategyMode = ML_AUTONOMOUS`).

## Features (`ML-FEATURES-AUTONOMOUS-v1`)

The feature set is ML-FEATURES-COMMUNITY-v1 (the entry context) plus these groups:

| Group | Features |
| --- | --- |
| DYNAMICS | returns 30 s / 1 m / 5 m / 15 m, volatility, acceleration, liquidity change, trade rate, new / returning buyers, drawdown from the 5 m high |
| EXECUTION | liquidity now, entry / exit impact, exit capacity ratio, round-trip cost, quote age |
| REGIME | launch rate, median launch return, positive share, HOT / NORMAL / COLD |
| POSITION | unrealized net after exit costs, MFE / MAE, drawdown from the peak, hold time, costs paid and expected |
| PORTFOLIO | exposure, open positions, day P&L |

- **POSITION rows:** the entry context is frozen at entry.
- **PORTFOLIO:** recorded on decisions, but not a model input (it cannot be reconstructed for replayed rows).
- **Time correctness:** samples after the decision moment are cut; late groups are excluded and audited; missing = null.

## Labels (`AUTO-LABELS-v1`, `labels.ts`)

- **ENTRY:** net result of buying the reference order (20 USD) at t and selling at t + 10 min, with impact at the liquidity of each moment plus 30 bps per side. The downside is taken from the bucket lows.
- **POSITION:** the net of selling at t + 2 min minus the net of selling now.
- **Excluded, never guessed:**
  - no path, or t before the path start;
  - no price at t;
  - a data gap overlapping the horizon;
  - observation ended early (migration, budget, restart);
  - horizon beyond the path.
- **Uncertainty:** horizon bucket resolution and assumed liquidity are recorded.
- **SKIP:** negative-value rows are the SKIP examples.

## Datasets and training

```bash
pnpm ml:autonomous:dataset          # AUTO-DATASET-v<n>: replay rows from outcome paths + labelled live snapshots
pnpm ml:autonomous:train            # newest autonomous dataset (or --dataset AUTO-DATASET-vN) [--seed 42]
pnpm ml:autonomous:status
```

**Dataset sources:**
- **REPLAY:** for every completed outcome path of an ML snapshot (AGE_30S / BUY_DECISION), one ENTRY row at the snapshot and POSITION rows of a virtual reference position at 10 s, 20 s, 30 s … 30 min (the engine evaluates a position from 10 s). The dynamics and position state come from the path prefix only.
- **LIVE:** MlAutonomousDecisionSnapshot rows labelled from the candidate's path.
- The manifest is the full coverage report: rows per kind / origin, exclusions per reason, null share per feature, label uncertainty, period and regimes.

**Training** (`ml/soltrader_ml/autonomous.py`):
- **Split:** chronological, with purge and embargo. A token (`group_id`) never appears in two blocks.
- **Policy:** selected on validation data.
- **Test report:**
  - backtest of the policy vs buy-all, a random choice with the same count, and skip-all;
  - liquidity stress (impact ×2 / ×3);
  - regimes and periods, missed opportunities;
  - walk-forward (4 folds);
  - overfitting (train vs test Spearman);
  - exit policy value vs always-hold.
- **Export:** export parity ≤ 1e-6 (trees == LightGBM), immutable directory (exit code 4 if the version exists), sha256 checksum.
- **Readiness:**
  - `INSUFFICIENT_DATA`: fewer than 2000 rows per kind;
  - `SHADOW_READY`: the test net P&L is positive, PF ≥ 1.2, ≥ 30 test trades, impact ×2 still positive, ≥ 75 % positive walk-forward folds, no overfitting, and the exit policy value is ≥ 0;
  - `RESEARCH_ONLY`: everything else.
- **Quality gate:** fewer than 300 rows per kind = no training at all.

### Memory: streaming dataset preparation and training

The web training and the CLI use the same builder (`buildAutonomousDatasetVersion`, apps/worker/src/training/pipeline.ts).
Memory is bounded by page / chunk sizes, not by the database size:

1. **Sources, paged:** `replaySourcePages` reads tracked snapshots with their outcome path keyset-paged
   (`ML_DATASET_REPLAY_PAGE_SIZE`, default 200) and joins the community context of the page's candidates only.
   `liveSourcePages` reads live snapshots per kind on the `(kind, at)` index (`ML_DATASET_LIVE_PAGE_SIZE`, default 500)
   and joins the positions and the outcome paths of the page's own mints (same `pathFor` rule as before, so the
   token-path join is correct across page boundaries). Pages are dropped after use.
2. **Rows → sorted chunks:** rows are built by the same functions as the in-memory builder (`replaySourceRows`,
   `liveSourceRow`), buffered up to `ML_DATASET_SORT_CHUNK_ROWS` (default 25 000), sorted and spilled to NDJSON chunk
   files in a new own work directory (`ml/autonomous-datasets/.build-*`, with an `owner.json` marker).
3. **Merge → CSV:** a k-way merge (at most 64 files at once, more in levels) writes `dataset.csv` line by line with a
   streaming SHA-256 and the incremental manifest statistics (`AutonomousDatasetStats`: counts per kind / origin,
   exclusions, null share per feature, label uncertainty, period, regimes, groups).
4. **Commit:** a new version directory is reserved with an exclusive `mkdir` (two builders never get the same
   version), the CSV is moved in, the manifest written, the hash re-read from disk and compared; then the label audit
   rows and, last, the `MlDatasetVersion` row. Failure / cancel: the reserved directory and the work directory (both
   own) are removed, nothing is registered. Existing datasets and models are never written.

Output equality: for the same sources the CSV is byte-identical and the manifest equal to the previous in-memory
builder (tests: `autonomous-dataset-parity.test.ts`, `dataset-writer.test.ts`, `dataset-streaming.e2e.test.ts`).
Measured (synthetic, full 60-minute paths): 600 015 rows / 347 MB CSV under a 256 MB heap limit, peak heap 145 MB, the
same SHA-256 as the old builder; 1 000 012 rows peak heap 173 MB. The old builder needed ~7 KB of heap per row
(600 015 rows: 3.9 GB) and fails under 768 MB with the production error.

**Python trainer:** by default `load_streaming` (ml/soltrader_ml/autonomous_data.py) reads the CSV in chunks: the
meta / label columns into RAM, the raw feature values into a float64 memmap per kind in the work directory passed by
the job (`--work-dir`, `ml/autonomous-models/.work-*`, removed after the child exits), category features as small
integer codes. Column specs, training matrices (memory-mapped, built once per component, deleted after fitting) and
predictions (in blocks) are computed from those arrays with the same element-wise code, so the bundle is identical to
the in-memory path (`--in-memory`; test `test_autonomous_streaming.py`, plus a one-off check against the previous
trainer: identical bundle, metrics and parity outputs). float64 is kept on purpose (float32 would change the LightGBM
bins); hyperparameters, splits, purge / embargo, single thread and low priority are unchanged. Measured on the same 600 015-row
synthetic dataset (553 860 POSITION rows): streaming peak private memory 724 MB (working set 1.8 GB incl. reclaimable
memory-mapped file pages), 227 s; the previous in-memory path 3 366 MB, 305 s (it would exceed a 3 GB container);
identical bundle and metrics. Free disk during a
training: about 4x the final `dataset.csv` (measured: 347 MB CSV -> 575 MB raw arrays + the largest training matrix).

## Lifecycle (explicit administrator actions, e-mail confirmed)

1. `TRAINED` (registered by the CLI) → `VALIDATED` → `SHADOW`. `POST /api/ml/autonomous/bundles/:v/status`, one step at a time. `INSUFFICIENT_DATA` never reaches SHADOW.
2. **SHADOW:** the newest SHADOW bundle decides on every entry snapshot without executing.
3. **PAPER approval:** `POST /api/ml/autonomous/bundles/:v/paper-approval`. Blockers: status SHADOW, readiness SHADOW_READY, ≥ 500 SHADOW decisions, intact artifact.
4. **Selection:** `PUT /api/settings/ml-paper {strategyMode: 'ML_AUTONOMOUS', autonomousBundleVersion}` (admin + e-mail, PAPER). Approval alone selects nothing.
5. **Revoke / retire:** no new entries; open positions run on fail-safes; no fallback.

## Evaluation

- **API:** `GET /api/ml/autonomous/comparison` compares DEFAULT, ML v3 (ML-FEATURES-v1 models), Community ML and Autonomous ML. Each comes from its own ledger (PAPER trades vs the separate autonomous account); accounts and P&L are never mixed. It reports PF, net P&L, expectancy, win rate, maximum drawdown, trade count and fees / slippage / impact.
- **Offline:** backtests, stress tests and regime / period results are in the bundle metrics.
- **UI:** Machine Learning → Autonomous ML.

## Configuration (worker)

| Variable | Default | |
| --- | --- | --- |
| `AUTONOMOUS_ML_ENABLED` | `true` | collection + engine (trading still needs an approved, selected bundle) |
| `AUTONOMOUS_ML_MAX_SNAPSHOTS_PER_MIN` | `120` | snapshot budget (DB load) |
| `AUTONOMOUS_PAPER_INITIAL_BALANCE` | `1000` | virtual starting balance of a new autonomous account |

## Known limitations

- **No real bundle has been trained yet.** It needs real outcome paths: run `pnpm ml:autonomous:dataset` on the server after collection. The local development database has no real paths.
- **Replayed ENTRY rows** (from AGE_30S snapshots) have no pre-snapshot dynamics (their path starts at the snapshot). Live snapshots fill this over time.
- **The entry label** uses a fixed 10 min hold, and the exit label a 2 min horizon; this is not a full sequential policy value. Offline reinforcement learning is a separate, later task.
- **Sizing** is a deterministic policy over the model outputs (no learned sizing model yet).
- **Execution** is simulated with the PAPER cost model (no partial fills, no latency model in the autonomous ledger).
- **SHADOW decisions** exist for entries only (no shadow exit decisions without positions).
- **Position size vs. replay:** replayed POSITION rows use a 20 USD reference order, so their cost / impact features
  (`costsIncurredPct`, `estimatedExitImpactPct`, `exitCapacityRatio`, …) only cover that size. Live positions much
  larger than 20 USD are partly out of distribution until live POSITION rows of real sizes are collected.

## End-to-end test

`pnpm test:e2e` (local development database only; refuses any non-local `DATABASE_URL`, cleans up every row / file):
empty state → data collection → dataset → web training job (real Python trainer) → listed, not active → check,
SHADOW decisions, approval, manual selection → PAPER BUY / HOLD / SELL and settlement → second model while the first
stays active → manual switch (open position stays with its own model) → corrupted model: no BUY, the mandatory
protection still closes the open position. The market and history are synthetic (learnable on purpose): the test
proves the pipeline, not profitability.

## Web training (Machine Learning → „+ Új ML modell tanítása”)

**Flow:**
1. The modal shows the real data state (`GET /api/ml/autonomous/dataset-readiness`) and what is missing.
2. **Indítás** creates a durable `MlTrainingJob` (`POST /api/ml/autonomous/training-jobs`, admin only, audited).
3. The separate **ml-trainer** process (`pnpm --dir apps/worker training`, Docker service `ml-trainer`) claims the job and runs:
   - `PREPARING_DATASET`: a new immutable AUTO-DATASET, or the chosen one, hash verified;
   - `TRAINING`: Python, with real stage events ENTRY_MODELS, EXIT_MODELS, POSITION_SIZING;
   - `VALIDATING`: export parity, backtests, stress tests, readiness;
   - `SAVING` → `COMPLETED`: checksum verified, new TRAINED row.

   It can also end `FAILED` or `CANCELLED`.

**Guarantees:**
- At most one active job (`activeKey` is unique): a double click returns the running job (409).
- Every training input is validated: no path, shell command or CLI argument ever reaches the trainer.
- A heartbeat and lease hold the job. After a restart, a job that was running becomes `FAILED` (`INTERRUPTED`), never `COMPLETED`.
- Cancel kills the Python child process.
- The child process gets no database URL and no secrets. It runs with `nice` (Linux), 1 numeric thread and a timeout; the container `cpus` / `mem_limit` apply.
- Never in the trading worker, never during an HTTP request, no trading side effect. A trained model is TRAINED only.

**After training:**
1. „Modell ellenőrzése” (`POST /api/ml/autonomous/models/:v/check`) is allowed for SHADOW_READY models only; research models stay research models.
2. The model then decides without executing until ≥ 500 check decisions exist.
3. Then follows the admin approval, and finally activation in Settings → „Aktív kereskedési ML modell”: e-mail confirmation, audited. The options are „Nincs modell – csak adatgyűjtés” or the approved models.

| Variable | Default | |
| --- | --- | --- |
| `ML_PYTHON` | `ml/.venv/...` (Docker: `/opt/ml-venv/bin/python`) | Python with the pinned requirements |
| `ML_TRAINER_TIMEOUT_MIN` | 120 | the job fails after this |
| `ML_TRAINER_NICE` | 10 | CPU priority (Linux) |
| `ML_TRAINER_THREADS` | 1 | numeric library threads |
| `ML_TRAINER_CPUS` / `ML_TRAINER_MEMORY` | 1.0 / 2g | compose limits of the ml-trainer container |

**Docker:**
- The `ml-trainer` image target is Debian slim with `python3` and a venv, because LightGBM wheels need glibc and the node images are Alpine.
- `ml/autonomous-datasets` and `ml/autonomous-models` are bind-mounted into worker, api and ml-trainer, so they survive rebuilds.
- Inside the containers the database is reached on the compose network (`DATABASE_URL_DOCKER`, `postgres:5432`). From a host terminal use the host-mapped port instead; do not change the container URL for that.
- A VPS override (`docker-compose.vps.yml`) must add the same `ml-trainer` service and volumes if it does not extend this file.

