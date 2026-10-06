export type BacktestSplit = 'TRAINING' | 'VALIDATION' | 'OUT_OF_SAMPLE';

export interface HistoricalBar {
  timestamp: Date;
  token: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  signal?: BacktestSignal;
}

export interface BacktestSignal {
  action: 'BUY' | 'SELL' | 'WATCH' | 'REJECT';
  score: number;
  riskScore: number;
  strategy: string;
  reasons: string[];
}

export interface BacktestTrade {
  id: string;
  token: string;
  strategy: string;
  entryTime: Date;
  exitTime: Date;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  fees: number;
  slippage: number;
  netPnl: number;
  holdingTimeMs: number;
  exitReason: string;
  split: BacktestSplit;
}

export interface BacktestConfig {
  initialEquity: number;
  feeBps: number;
  slippagePercent: number;
  executionDelayBars: number;
  partialExitPercent: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopPercent: number;
  positionPercent: number;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  initialEquity: 10_000,
  feeBps: 30,
  slippagePercent: 0.5,
  executionDelayBars: 1,
  partialExitPercent: 0.5,
  stopLossPercent: 2,
  takeProfitPercent: 4,
  trailingStopPercent: 2,
  positionPercent: 2,
};

export interface BacktestDecisionContext {
  current: HistoricalBar;
  history: readonly HistoricalBar[];
  index: number;
}

export type BacktestSignalEvaluator = (context: BacktestDecisionContext) => BacktestSignal | null;

export interface BacktestMetrics {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  fees: number;
  slippage: number;
  profitFactor: number;
  expectancy: number;
  maximumDrawdown: number;
  averageTrade: number;
  averageWin: number;
  averageLoss: number;
  averageHoldingTimeMs: number;
  maxConsecutiveLosses: number;
  endingEquity: number;
  returnPercent: number;
}

export interface EquityPoint {
  timestamp: Date;
  equity: number;
  drawdown: number;
}

export interface BacktestResult {
  split: BacktestSplit;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
}

interface OpenPosition {
  token: string;
  strategy: string;
  entryTime: Date;
  entryPrice: number;
  quantity: number;
  remainingQuantity: number;
  fees: number;
  slippage: number;
  stopPrice: number;
  takeProfitPrice: number;
  trailingStopPrice: number;
  highestPrice: number;
  split: BacktestSplit;
  partialExitTaken: boolean;
}

function applySlippage(price: number, percent: number, side: 'BUY' | 'SELL') {
  return side === 'BUY' ? price * (1 + percent / 100) : price * (1 - percent / 100);
}

function calculateMetrics(trades: BacktestTrade[], equityCurve: EquityPoint[], initialEquity: number): BacktestMetrics {
  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl <= 0);
  const grossProfit = wins.reduce((sum, trade) => sum + Math.max(0, trade.grossPnl), 0);
  const grossLoss = losses.reduce((sum, trade) => sum + Math.min(0, trade.grossPnl), 0);
  const netProfit = trades.reduce((sum, trade) => sum + trade.netPnl, 0);
  let consecutive = 0;
  let maxConsecutiveLosses = 0;
  for (const trade of trades) {
    consecutive = trade.netPnl <= 0 ? consecutive + 1 : 0;
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, consecutive);
  }
  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length === 0 ? 0 : wins.length / trades.length,
    grossProfit,
    grossLoss,
    netProfit,
    fees: trades.reduce((sum, trade) => sum + trade.fees, 0),
    slippage: trades.reduce((sum, trade) => sum + trade.slippage, 0),
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Number.POSITIVE_INFINITY : 0) : grossProfit / Math.abs(grossLoss),
    expectancy: trades.length === 0 ? 0 : netProfit / trades.length,
    maximumDrawdown: equityCurve.reduce((max, point) => Math.max(max, point.drawdown), 0),
    averageTrade: trades.length === 0 ? 0 : netProfit / trades.length,
    averageWin: wins.length === 0 ? 0 : wins.reduce((sum, trade) => sum + trade.netPnl, 0) / wins.length,
    averageLoss: losses.length === 0 ? 0 : losses.reduce((sum, trade) => sum + trade.netPnl, 0) / losses.length,
    averageHoldingTimeMs: trades.length === 0 ? 0 : trades.reduce((sum, trade) => sum + trade.holdingTimeMs, 0) / trades.length,
    maxConsecutiveLosses,
    endingEquity: equityCurve.at(-1)?.equity ?? initialEquity,
    returnPercent: initialEquity === 0 ? 0 : ((equityCurve.at(-1)?.equity ?? initialEquity) - initialEquity) / initialEquity * 100,
  };
}

function validateBars(bars: readonly HistoricalBar[]) {
  for (let index = 0; index < bars.length; index += 1) {
    if (![bars[index].open, bars[index].high, bars[index].low, bars[index].close, bars[index].volume].every(Number.isFinite)) {
      throw new Error(`Malformed historical bar at index ${index}`);
    }
    if (index === 0) continue;
    if (bars[index].timestamp.getTime() <= bars[index - 1].timestamp.getTime()) {
      throw new Error('Historical bars must be strictly chronological');
    }
  }
}

export class HistoricalBacktestEngine {
  constructor(private readonly config: BacktestConfig = DEFAULT_BACKTEST_CONFIG) {}

  run(bars: readonly HistoricalBar[], evaluator: BacktestSignalEvaluator, split: BacktestSplit = 'TRAINING'): BacktestResult {
    validateBars(bars);
    const trades: BacktestTrade[] = [];
    const equityCurve: EquityPoint[] = [];
    let equity = this.config.initialEquity;
    let peakEquity = equity;
    const positions = new Map<string, OpenPosition>();

    for (let index = 0; index < bars.length; index += 1) {
      const bar = bars[index];
      for (const [token, position] of positions) {
        if (token !== bar.token) continue;
        position.highestPrice = Math.max(position.highestPrice, bar.high);
        position.trailingStopPrice = position.highestPrice * (1 - this.config.trailingStopPercent / 100);
        const stopHit = bar.low <= position.stopPrice;
        const takeProfitHit = bar.high >= position.takeProfitPrice;
        const trailingHit = bar.low <= position.trailingStopPrice;
        const exitReason = stopHit ? 'STOP_LOSS' : takeProfitHit ? 'TAKE_PROFIT' : trailingHit ? 'TRAILING_STOP' : undefined;
        if (!exitReason) continue;
        const exitPrice = stopHit ? position.stopPrice : takeProfitHit ? position.takeProfitPrice : position.trailingStopPrice;
        const quantity = takeProfitHit && !position.partialExitTaken ? position.remainingQuantity * this.config.partialExitPercent : position.remainingQuantity;
        const closePrice = applySlippage(exitPrice, this.config.slippagePercent, 'SELL');
        const value = closePrice * quantity;
        const fee = value * this.config.feeBps / 10_000;
        const slippage = Math.abs(exitPrice - closePrice) * quantity;
        const grossPnl = (closePrice - position.entryPrice) * quantity;
        const netPnl = grossPnl - fee - slippage - position.fees * (quantity / position.quantity);
        equity += netPnl;
        trades.push({ id: `${position.token}-${position.entryTime.getTime()}-${trades.length}`, token: position.token, strategy: position.strategy, entryTime: position.entryTime, exitTime: bar.timestamp, entryPrice: position.entryPrice, exitPrice: closePrice, quantity, grossPnl, fees: fee + position.fees * (quantity / position.quantity), slippage: slippage + position.slippage * (quantity / position.quantity), netPnl, holdingTimeMs: bar.timestamp.getTime() - position.entryTime.getTime(), exitReason, split: position.split });
        if (takeProfitHit && !position.partialExitTaken && quantity < position.remainingQuantity) {
          position.remainingQuantity -= quantity;
          position.partialExitTaken = true;
        } else {
          positions.delete(token);
        }
      }

      peakEquity = Math.max(peakEquity, equity);
      equityCurve.push({ timestamp: bar.timestamp, equity, drawdown: peakEquity === 0 ? 0 : (peakEquity - equity) / peakEquity });

      const signal = evaluator({ current: bar, history: bars.slice(0, index + 1), index });
      if (!signal || signal.action !== 'BUY' || positions.has(bar.token) || index + this.config.executionDelayBars >= bars.length) continue;
      const fillBar = bars[index + this.config.executionDelayBars];
      const entryPrice = applySlippage(fillBar.open, this.config.slippagePercent, 'BUY');
      const notional = equity * this.config.positionPercent / 100;
      const quantity = notional / entryPrice;
      const fee = notional * this.config.feeBps / 10_000;
      const slippage = Math.abs(entryPrice - fillBar.open) * quantity;
      positions.set(bar.token, { token: bar.token, strategy: signal.strategy, entryTime: fillBar.timestamp, entryPrice, quantity, remainingQuantity: quantity, fees: fee, slippage, stopPrice: entryPrice * (1 - this.config.stopLossPercent / 100), takeProfitPrice: entryPrice * (1 + this.config.takeProfitPercent / 100), trailingStopPrice: entryPrice * (1 - this.config.trailingStopPercent / 100), highestPrice: entryPrice, split, partialExitTaken: false });
    }

    return { split, trades, equityCurve, metrics: calculateMetrics(trades, equityCurve, this.config.initialEquity) };
  }

  walkForward(bars: readonly HistoricalBar[], evaluator: BacktestSignalEvaluator, trainingBars: number, validationBars: number, outOfSampleBars: number): BacktestResult[] {
    if (trainingBars <= 0 || validationBars <= 0 || outOfSampleBars <= 0) throw new Error('Walk-forward windows must be positive');
    const results: BacktestResult[] = [];
    for (let start = 0; start + trainingBars + validationBars + outOfSampleBars <= bars.length; start += outOfSampleBars) {
      results.push(this.run(bars.slice(start, start + trainingBars), evaluator, 'TRAINING'));
      results.push(this.run(bars.slice(start + trainingBars, start + trainingBars + validationBars), evaluator, 'VALIDATION'));
      results.push(this.run(bars.slice(start + trainingBars + validationBars, start + trainingBars + validationBars + outOfSampleBars), evaluator, 'OUT_OF_SAMPLE'));
    }
    return results;
  }
}
