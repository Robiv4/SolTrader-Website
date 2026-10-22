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
- **REPLAY:** for every completed outcome path of an ML snapshot (AGE_30S / BUY_DECISION), one ENTRY row at the snapshot and POSITION rows of a virtual reference position at 30 s … 30 min. The dynamics and position state come from the path prefix only.
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
