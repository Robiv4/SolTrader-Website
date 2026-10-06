# Historical Backtesting Methodology

The backtester replays a strictly chronological array of historical bars. Each strategy decision receives only the current bar and the bars that precede it. Future bars are never included in the decision context.

## Execution

Signals are evaluated at the current bar. Entries fill on a later bar according to `executionDelayBars`, using that bar's open plus configured buy slippage. Exits use the current bar's stop, take-profit, or trailing-stop trigger and apply sell slippage. Fees are charged on entry and exit. Partial take-profit exits are recorded as separate trade records.

The engine does not call blockchain, broker, wallet, or live execution code. It is a deterministic simulation of the configured assumptions, not a profitability claim.

## Splits

- `TRAINING`: historical data used to develop or inspect a strategy.
- `VALIDATION`: a later segment used to check behavior against the training period.
- `OUT_OF_SAMPLE`: a final unseen segment used for an independent evaluation.

`walkForward()` runs these segments in chronological windows. Window sizes are explicit and must be positive. Strategy configuration should be fixed before evaluating an out-of-sample segment.

## Metrics

Results include trade counts, wins, losses, win rate, gross and net P&L, fees, slippage, profit factor, expectancy, drawdown, average trade, average win/loss, holding time, and consecutive losses. These statistics describe the supplied data and assumptions; they do not guarantee future performance.
