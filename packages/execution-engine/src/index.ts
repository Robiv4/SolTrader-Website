import crypto from 'node:crypto';

import type { Prisma, PrismaClient } from '@prisma/client';

export interface ExecutionPlan {
  mode: 'PAPER' | 'SEMI_AUTO' | 'LIVE';
  approved: boolean;
  status: 'queued' | 'rejected' | 'executed';
}

export function buildExecutionPlan(mode: 'PAPER' | 'SEMI_AUTO' | 'LIVE', _liveTradingEnabled: boolean): ExecutionPlan {
  if (mode !== 'PAPER') return { mode, approved: false, status: 'rejected' };
  return { mode, approved: true, status: 'queued' };
}

export interface PaperTradingConfig {
  maxPositionPercent: number;
  maxTotalExposurePercent: number;
  maxSimultaneousPositions: number;
  dailyLossLimitPercent: number;
  maxSlippagePercent: number;
  minSignalScore: number;
  maxRiskPerTradePercent: number;
  feeBps: number;
  priorityFeeUsd: number;
  executionDelayMs: number;
  partialFillRatio: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopPercent: number;
  cooldownMs: number;
}

export const DEFAULT_PAPER_TRADING_CONFIG: PaperTradingConfig = {
  maxPositionPercent: 2,
  maxTotalExposurePercent: 25,
  maxSimultaneousPositions: 5,
  dailyLossLimitPercent: 5,
  maxSlippagePercent: 3,
  minSignalScore: 70,
  maxRiskPerTradePercent: 1,
  feeBps: 30,
  priorityFeeUsd: 0,
  executionDelayMs: 0,
  partialFillRatio: 1,
  stopLossPercent: 2,
  takeProfitPercent: 4,
  trailingStopPercent: 2,
  cooldownMs: 15 * 60 * 1000,
};

/**
 * Returns process defaults only. User-specific paper limits are loaded from
 * PostgreSQL by the worker and must never be supplied through environment variables.
 */
export function loadPaperTradingConfig(): PaperTradingConfig {
  return { ...DEFAULT_PAPER_TRADING_CONFIG };
}

export interface PaperSignal {
  token: string;
  timestamp: Date;
  strategy: string;
  score: number;
  riskScore: number;
  recommendedAction: 'BUY' | 'SELL' | 'WATCH' | 'REJECT';
  reasons: string[];
}

export interface PaperMarketData {
  token: string;
  symbol: string;
  priceUsd: number;
  liquidityUsd: number;
  volatilityPercent: number;
  slippageEstimatePercent: number;
}

export type PaperOrderStatus = 'QUEUED' | 'PARTIALLY_FILLED' | 'FILLED' | 'REJECTED' | 'CANCELLED';

export interface PaperOrder {
  id: string;
  token: string;
  symbol: string;
  strategy: string;
  status: PaperOrderStatus;
  createdAt: Date;
  requestedNotionalUsd: number;
  filledNotionalUsd: number;
  quantity: number;
  executionPriceUsd?: number;
  feeUsd: number;
  slippageUsd: number;
  priorityFeeUsd: number;
  executionDelayMs: number;
  partialFillRatio: number;
  signalScore: number;
  riskScore: number;
  decisionReasons: string[];
  rejectionReason?: string;
}

export interface PaperPosition {
  id: string;
  token: string;
  symbol: string;
  quantity: number;
  entryPriceUsd: number;
  currentPriceUsd: number;
  notionalUsd: number;
  entryFeeUsd: number;
  entrySlippageUsd: number;
  priorityFeeUsd: number;
  stopLossPriceUsd: number;
  takeProfitPriceUsd: number;
  trailingStopPriceUsd: number;
  highestPriceUsd: number;
  strategy: string;
  signalScore: number;
  riskScore: number;
  openedAt: Date;
}

export interface PaperClosedTrade extends PaperPosition {
  exitPriceUsd: number;
  exitFeeUsd: number;
  exitSlippageUsd: number;
  grossPnlUsd: number;
  netPnlUsd: number;
  exitReason: string;
  closedAt: Date;
}

export interface PaperRiskEvent {
  code: string;
  token?: string;
  message: string;
  at: Date;
}

export interface PaperTradeStore {
  saveTrade(trade: PaperClosedTrade): Promise<void>;
  saveRiskEvent(event: PaperRiskEvent): Promise<void>;
}

export interface PositionSizingInput {
  accountEquityUsd: number;
  currentExposureUsd: number;
  signalScore: number;
  riskScore: number;
  volatilityPercent: number;
  liquidityUsd: number;
}

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function calculatePaperPositionSize(input: PositionSizingInput, config: PaperTradingConfig): number {
  const riskBudget = input.accountEquityUsd * config.maxRiskPerTradePercent / 100;
  const stopDistance = Math.max(config.stopLossPercent / 100, 0.005);
  const riskSized = riskBudget / stopDistance;
  const maxPosition = input.accountEquityUsd * config.maxPositionPercent / 100;
  const scoreFactor = clamp(input.signalScore / 100);
  const riskFactor = clamp(1 - input.riskScore / 100);
  const volatilityFactor = clamp(1 - input.volatilityPercent / 100, 0.25);
  const liquidityFactor = clamp(input.liquidityUsd / Math.max(input.accountEquityUsd * 10, 1), 0.25);
  const remainingExposure = Math.max(0, input.accountEquityUsd * config.maxTotalExposurePercent / 100 - input.currentExposureUsd);
  return Math.max(0, Math.min(riskSized, maxPosition, remainingExposure) * scoreFactor * riskFactor * volatilityFactor * liquidityFactor);
}

function validMarketData(market: PaperMarketData) {
  return [market.priceUsd, market.liquidityUsd, market.volatilityPercent, market.slippageEstimatePercent].every((value) => Number.isFinite(value) && value >= 0) && market.priceUsd > 0;
}

export class PaperTradingEngine {
  readonly mode = 'PAPER' as const;
  private readonly orders = new Map<string, PaperOrder>();
  private readonly positions = new Map<string, PaperPosition>();
  private readonly closedTrades: PaperClosedTrade[] = [];
  private readonly riskEvents: PaperRiskEvent[] = [];
  private readonly cooldowns = new Map<string, number>();
  private totalRealizedPnlUsd = 0;
  private dailyRealizedPnlUsd = 0;
  private peakEquityUsd: number;
  private lossDay = '';

  constructor(
    private readonly startingEquityUsd: number,
    private readonly config: PaperTradingConfig = DEFAULT_PAPER_TRADING_CONFIG,
    private readonly store?: PaperTradeStore,
  ) {
    if (!Number.isFinite(startingEquityUsd) || startingEquityUsd <= 0) throw new Error('Starting equity must be positive');
    this.peakEquityUsd = startingEquityUsd;
  }

  get accountEquityUsd() {
    const equity = this.startingEquityUsd + this.totalRealizedPnlUsd + [...this.positions.values()].reduce((total, position) => total + (position.currentPriceUsd - position.entryPriceUsd) * position.quantity, 0);
    this.peakEquityUsd = Math.max(this.peakEquityUsd, equity);
    return equity;
  }

  get drawdownPercent() { return Math.max(0, (this.peakEquityUsd - this.accountEquityUsd) / this.peakEquityUsd * 100); }
  get realizedPnlUsd() { return this.totalRealizedPnlUsd; }

  get openPositions() { return [...this.positions.values()]; }
  get closedPaperTrades() { return [...this.closedTrades]; }
  get activeRiskEvents() { return [...this.riskEvents]; }
  get currentExposureUsd() { return [...this.positions.values()].reduce((total, position) => total + position.notionalUsd, 0); }

  private async reject(code: string, message: string, token: string, at: Date) {
    const event = { code, token, message, at };
    this.riskEvents.push(event);
    await this.store?.saveRiskEvent(event);
  }

  private dailyLossPercent(at: Date) {
    const day = at.toISOString().slice(0, 10);
    if (this.lossDay !== day) {
      this.lossDay = day;
      this.dailyRealizedPnlUsd = 0;
    }
    return Math.max(0, -this.dailyRealizedPnlUsd) / this.startingEquityUsd * 100;
  }

  async createOrder(signal: PaperSignal, market: PaperMarketData, at = new Date()): Promise<PaperOrder> {
    const order: PaperOrder = {
      id: crypto.randomUUID(), token: signal.token, symbol: market.symbol, strategy: signal.strategy, status: 'REJECTED', createdAt: at,
      requestedNotionalUsd: 0, filledNotionalUsd: 0, quantity: 0, feeUsd: 0, slippageUsd: 0, priorityFeeUsd: this.config.priorityFeeUsd,
      executionDelayMs: this.config.executionDelayMs, partialFillRatio: this.config.partialFillRatio, signalScore: signal.score, riskScore: signal.riskScore, decisionReasons: signal.reasons,
    };
    const reject = async (code: string, message: string) => { order.rejectionReason = code; await this.reject(code, message, signal.token, at); return order; };
    if (!validMarketData(market)) return reject('MALFORMED_MARKET_DATA', 'Market data is incomplete or invalid.');
    if (signal.recommendedAction !== 'BUY') return reject('SIGNAL_NOT_BUY', 'Signal did not recommend a BUY action.');
    if (signal.score < this.config.minSignalScore) return reject('LOW_SIGNAL_SCORE', 'Signal score is below the configured minimum.');
    if (this.positions.size >= this.config.maxSimultaneousPositions) return reject('MAX_SIMULTANEOUS_POSITIONS', 'Maximum simultaneous positions reached.');
    if ((this.cooldowns.get(signal.token) ?? 0) > at.getTime()) return reject('COOLDOWN_ACTIVE', 'Token is in cooldown.');
    if (this.dailyLossPercent(at) >= this.config.dailyLossLimitPercent) return reject('DAILY_LOSS_LIMIT', 'Daily loss limit reached.');

    const requestedNotionalUsd = calculatePaperPositionSize({ accountEquityUsd: this.accountEquityUsd, currentExposureUsd: this.currentExposureUsd, signalScore: signal.score, riskScore: signal.riskScore, volatilityPercent: market.volatilityPercent, liquidityUsd: market.liquidityUsd }, this.config);
    if (requestedNotionalUsd <= 0) return reject('EXPOSURE_LIMIT', 'No position capacity remains.');
    order.status = 'QUEUED';
    order.requestedNotionalUsd = requestedNotionalUsd;
    this.orders.set(order.id, order);
    return order;
  }

  async fillOrder(orderId: string, market: PaperMarketData, at = new Date()) {
    const order = this.orders.get(orderId);
    if (!order) throw new Error('Paper order not found');
    if (order.status !== 'QUEUED' && order.status !== 'PARTIALLY_FILLED') return order;
    if (at.getTime() < order.createdAt.getTime() + order.executionDelayMs) return order;
    if (!validMarketData(market)) {
      order.status = 'REJECTED';
      await this.reject('MALFORMED_MARKET_DATA', 'Market data is incomplete or invalid.', order.token, at);
      return order;
    }

    const slippagePercent = Math.min(this.config.maxSlippagePercent, market.slippageEstimatePercent);
    const fillRatio = clamp(order.partialFillRatio);
    const executionPriceUsd = market.priceUsd * (1 + slippagePercent / 100);
    order.filledNotionalUsd = order.requestedNotionalUsd * fillRatio;
    order.quantity = order.filledNotionalUsd / executionPriceUsd;
    order.executionPriceUsd = executionPriceUsd;
    order.slippageUsd = order.filledNotionalUsd * slippagePercent / 100;
    order.feeUsd = order.filledNotionalUsd * this.config.feeBps / 10_000;
    order.status = fillRatio < 1 ? 'PARTIALLY_FILLED' : 'FILLED';
    if (order.filledNotionalUsd <= 0) { order.status = 'REJECTED'; order.rejectionReason = 'ZERO_FILL'; return order; }

    const position: PaperPosition = {
      id: order.id, token: order.token, symbol: order.symbol, quantity: order.quantity, entryPriceUsd: executionPriceUsd, currentPriceUsd: market.priceUsd,
      notionalUsd: order.filledNotionalUsd, entryFeeUsd: order.feeUsd, entrySlippageUsd: order.slippageUsd, priorityFeeUsd: order.priorityFeeUsd,
      stopLossPriceUsd: executionPriceUsd * (1 - this.config.stopLossPercent / 100), takeProfitPriceUsd: executionPriceUsd * (1 + this.config.takeProfitPercent / 100),
      trailingStopPriceUsd: executionPriceUsd * (1 - this.config.trailingStopPercent / 100), highestPriceUsd: market.priceUsd, strategy: order.strategy,
      signalScore: order.signalScore, riskScore: order.riskScore, openedAt: at,
    };
    this.positions.set(position.id, position);
    return order;
  }

  async evaluateExits(market: PaperMarketData, at = new Date()) {
    const closed: PaperClosedTrade[] = [];
    for (const position of this.positions.values()) {
      if (position.token !== market.token) continue;
      position.currentPriceUsd = market.priceUsd;
      position.highestPriceUsd = Math.max(position.highestPriceUsd, market.priceUsd);
      position.trailingStopPriceUsd = position.highestPriceUsd * (1 - this.config.trailingStopPercent / 100);
      const reason = market.priceUsd <= position.stopLossPriceUsd ? 'STOP_LOSS' : market.priceUsd >= position.takeProfitPriceUsd ? 'TAKE_PROFIT' : market.priceUsd <= position.trailingStopPriceUsd ? 'TRAILING_STOP' : undefined;
      if (reason) closed.push(await this.closePosition(position.id, market, reason, at));
    }
    return closed;
  }

  async closePosition(positionId: string, market: PaperMarketData, exitReason: string, at = new Date()): Promise<PaperClosedTrade> {
    const position = this.positions.get(positionId);
    if (!position) throw new Error('Paper position not found');
    const exitSlippagePercent = Math.min(this.config.maxSlippagePercent, market.slippageEstimatePercent);
    const exitPriceUsd = market.priceUsd * (1 - exitSlippagePercent / 100);
    const exitNotionalUsd = exitPriceUsd * position.quantity;
    const exitFeeUsd = exitNotionalUsd * this.config.feeBps / 10_000;
    const exitSlippageUsd = exitNotionalUsd * exitSlippagePercent / 100;
    const grossPnlUsd = (exitPriceUsd - position.entryPriceUsd) * position.quantity;
    const netPnlUsd = grossPnlUsd - position.entryFeeUsd - exitFeeUsd - position.entrySlippageUsd - exitSlippageUsd - position.priorityFeeUsd;
    const closedTrade = { ...position, currentPriceUsd: market.priceUsd, exitPriceUsd, exitFeeUsd, exitSlippageUsd, grossPnlUsd, netPnlUsd, exitReason, closedAt: at };
    this.positions.delete(positionId);
    this.closedTrades.push(closedTrade);
    this.totalRealizedPnlUsd += netPnlUsd;
    this.dailyRealizedPnlUsd += netPnlUsd;
    this.cooldowns.set(position.token, at.getTime() + this.config.cooldownMs);
    await this.store?.saveTrade(closedTrade);
    return closedTrade;
  }
}

export class PrismaPaperTradeStore implements PaperTradeStore {
  constructor(private readonly prisma: Pick<PrismaClient, 'trade' | 'riskEvent' | 'token'>, private readonly userId: string) {}

  async saveTrade(trade: PaperClosedTrade) {
    const token = await this.prisma.token.upsert({ where: { address: trade.token }, update: { symbol: trade.symbol }, create: { address: trade.token, symbol: trade.symbol } });
    await this.prisma.trade.upsert({
      where: { id: trade.id },
      update: { exit: trade.exitPriceUsd, fees: trade.entryFeeUsd + trade.exitFeeUsd, pnl: trade.grossPnlUsd, netPnl: trade.netPnlUsd, exitReason: trade.exitReason, exitAt: trade.closedAt, status: 'CLOSED' },
      create: {
        id: trade.id, userId: this.userId, tokenId: token.id, tokenAddress: trade.token, symbol: trade.symbol, strategyName: trade.strategy, side: 'BUY',
        signalScore: trade.signalScore, riskScore: trade.riskScore, entry: trade.entryPriceUsd, exit: trade.exitPriceUsd, size: trade.notionalUsd, quantity: trade.quantity,
        fees: trade.entryFeeUsd + trade.exitFeeUsd, slippage: trade.entrySlippageUsd + trade.exitSlippageUsd, pnl: trade.grossPnlUsd, netPnl: trade.netPnlUsd,
        exitReason: trade.exitReason, paperDecision: { strategy: trade.strategy, signalScore: trade.signalScore, riskScore: trade.riskScore } as Prisma.InputJsonValue,
        mode: 'PAPER', status: 'CLOSED', entryAt: trade.openedAt, exitAt: trade.closedAt,
      },
    });
  }

  async saveRiskEvent(event: PaperRiskEvent) {
    await this.prisma.riskEvent.create({ data: { type: 'MANUAL_OVERRIDE', description: `${event.code}: ${event.message}`, severity: 'warning', metadata: { token: event.token, at: event.at.toISOString() } as Prisma.InputJsonValue } });
  }
}

export type TransactionState = 'CREATED' | 'QUOTED' | 'BUILT' | 'SIMULATED' | 'SIGNED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED';
export type ExecutionFailureClass = 'QUOTE_STALE' | 'PRICE_IMPACT_TOO_HIGH' | 'SLIPPAGE_TOO_HIGH' | 'RISK_LIMIT' | 'INSUFFICIENT_BALANCE' | 'RPC_UNHEALTHY' | 'DUPLICATE' | 'SIMULATION_FAILED' | 'BUILD_FAILED' | 'SIGNING_FAILED' | 'SUBMISSION_FAILED' | 'CONFIRMATION_FAILED' | 'LIVE_DISABLED' | 'UNKNOWN';
export type PriorityFeeMode = 'FIXED' | 'DYNAMIC' | 'CAPPED';

export interface ExecutionConfig {
  mode: 'PAPER' | 'LIVE';
  quoteMaxAgeMs: number;
  maxPriceImpactPercent: number;
  maxSlippagePercent: number;
  priorityFeeMode: PriorityFeeMode;
  fixedPriorityFeeLamports: number;
  maxPriorityFeeLamports: number;
  retryableFailures: ExecutionFailureClass[];
}

export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = {
  mode: 'PAPER',
  quoteMaxAgeMs: 10_000,
  maxPriceImpactPercent: 3,
  maxSlippagePercent: 3,
  priorityFeeMode: 'CAPPED',
  fixedPriorityFeeLamports: 1_000,
  maxPriorityFeeLamports: 10_000,
  retryableFailures: ['RPC_UNHEALTHY'],
};

export interface ExecutionRequest {
  idempotencyKey: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  maxSlippagePercent: number;
  riskApproved: boolean;
  walletBalance: number;
  walletAddress?: string;
  requestedAt?: Date;
}

export interface ExecutionQuote {
  id: string;
  requestKey: string;
  route: string[];
  amountIn: number;
  expectedOutput: number;
  referencePrice: number;
  priceImpactPercent: number;
  quotedAt: Date;
  expiresAt: Date;
  providerData?: unknown;
}

export interface BuiltTransaction {
  quoteId: string;
  serialized: string;
  computeUnitLimit: number;
  priorityFeeLamports: number;
  minimumAcceptableOutput: number;
}

export interface SignedTransaction {
  quoteId: string;
  serialized: string;
  signature: string;
}

export interface ExecutionRecord {
  idempotencyKey: string;
  state: TransactionState;
  failure?: { classification: ExecutionFailureClass; message: string };
  quote?: ExecutionQuote;
  built?: BuiltTransaction;
  signed?: SignedTransaction;
  attempts: number;
  updatedAt: Date;
}

export interface QuoteProvider {
  requestQuote(request: ExecutionRequest): Promise<ExecutionQuote>;
}

export interface RouteSelector {
  selectRoute(quote: ExecutionQuote): string[];
}

export interface TransactionBuilder {
  build(request: ExecutionRequest, quote: ExecutionQuote, route: string[], priorityFeeLamports: number): Promise<BuiltTransaction>;
}

export interface TransactionSimulator {
  simulate(transaction: BuiltTransaction): Promise<{ ok: boolean; error?: string }>;
}

export interface TradingWalletSigner {
  sign(transaction: BuiltTransaction): Promise<SignedTransaction>;
}

export interface TransactionBroadcaster {
  broadcast(transaction: SignedTransaction): Promise<string>;
  confirm(signature: string): Promise<boolean>;
}

export interface RpcHealthProbe {
  isHealthy(): Promise<boolean>;
}

export interface PriorityFeeOracle {
  getRecommendedPriorityFeeLamports(): Promise<number>;
}

export class ExecutionError extends Error {
  constructor(readonly classification: ExecutionFailureClass, message: string, readonly retryable = false) {
    super(message);
    this.name = 'ExecutionError';
  }
}

export function calculatePriorityFee(config: ExecutionConfig, recommendedLamports?: number) {
  if (config.priorityFeeMode === 'FIXED') return config.fixedPriorityFeeLamports;
  if (config.priorityFeeMode === 'DYNAMIC') return Math.max(0, recommendedLamports ?? 0);
  return Math.min(config.maxPriorityFeeLamports, Math.max(0, recommendedLamports ?? config.fixedPriorityFeeLamports));
}

export class ExecutionEngine {
  private readonly records = new Map<string, ExecutionRecord>();

  constructor(
    private readonly quoteProvider: QuoteProvider,
    private readonly routeSelector: RouteSelector,
    private readonly builder: TransactionBuilder,
    private readonly simulator: TransactionSimulator,
    private readonly signer: TradingWalletSigner,
    private readonly broadcaster: TransactionBroadcaster,
    private readonly rpcHealth: RpcHealthProbe,
    private readonly priorityFeeOracle?: PriorityFeeOracle,
    private readonly config: ExecutionConfig = DEFAULT_EXECUTION_CONFIG,
  ) {}

  getRecord(idempotencyKey: string) {
    return this.records.get(idempotencyKey);
  }

  async execute(request: ExecutionRequest): Promise<ExecutionRecord> {
    const existing = this.records.get(request.idempotencyKey);
    if (existing) {
      if (existing.state === 'CONFIRMED' || existing.state === 'SUBMITTED' || existing.state === 'SIGNED' || existing.state === 'SIMULATED' || existing.state === 'BUILT' || existing.state === 'QUOTED') {
        return existing;
      }
      if (existing.state === 'FAILED' && !existing.failure?.classification) return existing;
    }

    const record: ExecutionRecord = { idempotencyKey: request.idempotencyKey, state: 'CREATED', attempts: (existing?.attempts ?? 0) + 1, updatedAt: new Date() };
    this.records.set(request.idempotencyKey, record);
    const fail = (classification: ExecutionFailureClass, message: string) => {
      record.state = classification === 'LIVE_DISABLED' || classification === 'DUPLICATE' ? 'CANCELLED' : 'FAILED';
      record.failure = { classification, message };
      record.updatedAt = new Date();
      return record;
    };

    if (this.config.mode !== 'PAPER') return fail('LIVE_DISABLED', 'LIVE execution is disabled in this phase.');
    if (!request.idempotencyKey || request.amountIn <= 0 || !Number.isFinite(request.amountIn)) return fail('RISK_LIMIT', 'Execution request is invalid.');
    if (!request.riskApproved) return fail('RISK_LIMIT', 'Risk approval is required.');
    if (request.walletBalance < request.amountIn) return fail('INSUFFICIENT_BALANCE', 'Wallet balance is insufficient.');
    if (request.maxSlippagePercent > this.config.maxSlippagePercent) return fail('SLIPPAGE_TOO_HIGH', 'Requested slippage exceeds the configured cap.');

    try {
      const quote = await this.quoteProvider.requestQuote(request);
      record.quote = quote;
      record.state = 'QUOTED';
      record.updatedAt = new Date();
      const now = (request.requestedAt ?? new Date()).getTime();
      if (quote.expiresAt.getTime() <= now || now - quote.quotedAt.getTime() > this.config.quoteMaxAgeMs) return fail('QUOTE_STALE', 'Quote is stale or expired.');
      if (quote.priceImpactPercent > this.config.maxPriceImpactPercent) return fail('PRICE_IMPACT_TOO_HIGH', 'Quote price impact exceeds the configured cap.');
      if (quote.expectedOutput <= 0 || !Number.isFinite(quote.expectedOutput)) return fail('BUILD_FAILED', 'Quote expected output is invalid.');
      const minimumOutput = quote.expectedOutput * (1 - request.maxSlippagePercent / 100);
      if (minimumOutput <= 0) return fail('SLIPPAGE_TOO_HIGH', 'Minimum acceptable output is invalid.');
      if (!(await this.rpcHealth.isHealthy())) return fail('RPC_UNHEALTHY', 'RPC health check failed.');

      const route = this.routeSelector.selectRoute(quote);
      const recommendedFee = await this.priorityFeeOracle?.getRecommendedPriorityFeeLamports();
      record.built = await this.builder.build(request, { ...quote, expectedOutput: minimumOutput }, route, calculatePriorityFee(this.config, recommendedFee));
      record.state = 'BUILT';
      record.updatedAt = new Date();

      const simulation = await this.simulator.simulate(record.built);
      if (!simulation.ok) return fail('SIMULATION_FAILED', simulation.error ?? 'Transaction simulation failed.');
      record.state = 'SIMULATED';
      record.updatedAt = new Date();

      if (this.config.mode !== 'PAPER') return fail('LIVE_DISABLED', 'LIVE execution is disabled before signing.');
      return record;
    } catch (error) {
      if (error instanceof ExecutionError) return fail(error.classification, error.message);
      return fail('UNKNOWN', error instanceof Error ? error.message : String(error));
    }
  }

  async signAndBroadcast(idempotencyKey: string): Promise<ExecutionRecord> {
    const record = this.records.get(idempotencyKey);
    if (!record) throw new ExecutionError('UNKNOWN', 'Execution record not found');
    if (record.state !== 'SIMULATED' || !record.built) return record;
    record.state = 'FAILED';
    record.failure = { classification: 'LIVE_DISABLED', message: 'Signing and broadcasting are disabled while LIVE mode is disabled.' };
    record.updatedAt = new Date();
    return record;
  }

  async executeWithSafeRetry(request: ExecutionRequest, maxAttempts = 2): Promise<ExecutionRecord> {
    const attempts = Math.max(1, Math.floor(maxAttempts));
    let result = await this.execute(request);
    for (let attempt = 1; attempt < attempts; attempt += 1) {
      const classification = result.failure?.classification;
      if (!classification || !this.config.retryableFailures.includes(classification)) break;
      result = await this.execute({ ...request, idempotencyKey: `${request.idempotencyKey}:retry:${attempt}` });
    }
    return result;
  }
}

export * from './live-execution.js';
export * from './solana-adapters.js';
