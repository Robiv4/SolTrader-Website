import { bondingCurveBuyImpactPercent, type LaunchObservation, type LaunchState } from '@soltrader/strategy-engine';
import type { CurveState } from '@soltrader/trading-engine';

import type { MarketEvent } from '../exit/hot-position-monitor.js';

import type { LaunchEvent, LaunchSource, LaunchTradeEvent } from './providers.js';

/** Pump.fun tokens have a fixed total supply of 1 billion (6 decimals). */
const PUMP_FUN_TOTAL_SUPPLY = 1_000_000_000;

interface WalletActivity {
  buySol: number;
  sellSol: number;
  buyTokens: number;
  sellTokens: number;
  buys: number;
  sells: number;
}

export interface TrackedLaunch {
  mint: string;
  source: LaunchSource;
  detectedAt: number;
  createdAt: number | null;
  bondingCurve: string | null;
  poolAddress: string | null;
  quoteMint: string | null;
  creator: string | null;
  name: string | null;
  symbol: string | null;
  wallets: Map<string, WalletActivity> | null;
  buyCount: number;
  sellCount: number;
  buySol: number;
  sellSol: number;
  virtualSol: number | null;
  virtualToken: number | null;
  realSol: number | null;
  firstTradeAt: number | null;
  lastTradeAt: number | null;
  lastSlot: number | null;
  lastSignature: string | null;
  lastSourceTimestamp: number | null;
  migrated: boolean;
  observations: LaunchObservation[];
  /** Market-data snapshot fallback (sources without a trade stream, e.g. Raydium). */
  external: { priceUsd: number | null; liquidityUsd: number | null; buyCount: number; sellCount: number; volumeUsd: number; at: number } | null;
  keepAlive: boolean;
  detectedPriceUsd: number | null;
  metadataUri: string | null;
}

export interface LaunchQuote {
  priceUsd: number;
  liquidityUsd: number | null;
  timestamp: Date;
  /** True for bonding-curve tokens priced from the live trade stream (the price only moves on a trade). */
  streaming: boolean;
  /** Price impact (%) of buying `usd` right now, from the real curve/pool state; null when unknown. */
  impactPercentFor(usd: number): number | null;
  /** Live bonding-curve reserves (pool model for exit capacity); null for pools priced from market data. */
  curve: CurveState | null;
  /** The bonding curve completed (migrated): the curve can no longer be traded. */
  migrated: boolean;
}

/**
 * Real-time state of every freshly detected token: wallets, buys/sells, reserves and a 2-second observation
 * series. Bounded: tokens leave after the retention window unless an open position keeps them alive.
 */
export class LaunchTracker {
  readonly launches = new Map<string, TrackedLaunch>();
  private solUsd: number | null = null;
  private readonly priceListeners = new Set<(event: MarketEvent) => void>();

  /** Subscribes to every price change (trade stream / market-data snapshot); used by the hot exit monitor. */
  onPriceEvent(listener: (event: MarketEvent) => void) {
    this.priceListeners.add(listener);
    return () => this.priceListeners.delete(listener);
  }

  private emit(launch: TrackedLaunch) {
    if (!this.priceListeners.size) return;
    const event = this.latestEvent(launch.mint);
    if (!event) return;
    for (const listener of this.priceListeners) {
      try {
        listener(event);
      } catch {
        // A listener failure must never break stream handling.
      }
    }
  }

  /** Latest market state of a token as a normalized event (no I/O). */
  latestEvent(mint: string): MarketEvent | null {
    const launch = this.launches.get(mint);
    if (!launch) return null;
    const price = this.priceUsd(launch);
    if (!price) return null;
    if (launch.wallets) {
      if (!launch.lastTradeAt) return null;
      return { mint, price, liquidityUsd: this.liquidityUsd(launch), marketTimestamp: launch.lastTradeAt, sourceTimestamp: launch.lastSourceTimestamp, receivedAt: launch.lastTradeAt, slot: launch.lastSlot, eventId: launch.lastSignature, source: 'PUMP_FUN_STREAM', curve: this.curveState(launch), migrated: launch.migrated };
    }
    if (!launch.external) return null;
    return { mint, price, liquidityUsd: this.liquidityUsd(launch), marketTimestamp: launch.external.at, sourceTimestamp: null, receivedAt: launch.external.at, slot: null, eventId: null, source: 'MARKET_DATA_SNAPSHOT' };
  }

  constructor(private readonly retentionMs: number, private readonly maxTracked = 2_000) {}

  setSolPrice(price: number | null) {
    if (price && price > 0) this.solUsd = price;
  }

  get solPriceUsd() {
    return this.solUsd;
  }

  /** Adds a launch once; duplicate events for the same mint return false. */
  add(event: LaunchEvent): boolean {
    if (this.launches.has(event.mint)) return false;
    if (this.launches.size >= this.maxTracked) this.evictOldest();
    this.launches.set(event.mint, {
      mint: event.mint, source: event.source, detectedAt: event.detectedAt, createdAt: event.createdAt, bondingCurve: event.bondingCurve,
      poolAddress: event.poolAddress, quoteMint: event.quoteMint, creator: event.creator, name: event.name, symbol: event.symbol,
      wallets: event.source === 'PUMP_FUN' ? new Map() : null, buyCount: 0, sellCount: 0, buySol: 0, sellSol: 0,
      virtualSol: null, virtualToken: null, realSol: null, firstTradeAt: null, lastTradeAt: null, lastSlot: null, lastSignature: null, lastSourceTimestamp: null, migrated: false, observations: [],
      external: null, keepAlive: false, detectedPriceUsd: null, metadataUri: event.metadataUri ?? null,
    });
    return true;
  }

  /** Keeps (or re-creates after a restart) tracking for a token with an open position. */
  keep(mint: string, fallback: Partial<LaunchEvent> = {}) {
    const existing = this.launches.get(mint);
    if (existing) {
      existing.keepAlive = true;
      return;
    }
    this.add({ source: fallback.source ?? 'PUMP_FUN', mint, detectedAt: fallback.detectedAt ?? Date.now(), createdAt: fallback.createdAt ?? null, bondingCurve: fallback.bondingCurve ?? null, poolAddress: fallback.poolAddress ?? null, quoteMint: fallback.quoteMint ?? null, creator: fallback.creator ?? null, name: fallback.name ?? null, symbol: fallback.symbol ?? null });
    this.launches.get(mint)!.keepAlive = true;
  }

  release(mints: Set<string>) {
    for (const launch of this.launches.values()) if (launch.keepAlive && !mints.has(launch.mint)) launch.keepAlive = false;
  }

  onTrade(trade: LaunchTradeEvent) {
    const launch = this.launches.get(trade.mint);
    if (!launch || !launch.wallets) return;
    const wallet = launch.wallets.get(trade.wallet) ?? { buySol: 0, sellSol: 0, buyTokens: 0, sellTokens: 0, buys: 0, sells: 0 };
    if (trade.isBuy) {
      wallet.buySol += trade.solAmount;
      wallet.buyTokens += trade.tokenAmount;
      wallet.buys += 1;
      launch.buyCount += 1;
      launch.buySol += trade.solAmount;
    } else {
      wallet.sellSol += trade.solAmount;
      wallet.sellTokens += trade.tokenAmount;
      wallet.sells += 1;
      launch.sellCount += 1;
      launch.sellSol += trade.solAmount;
    }
    launch.wallets.set(trade.wallet, wallet);
    launch.virtualSol = trade.virtualSolReserves;
    launch.virtualToken = trade.virtualTokenReserves;
    launch.realSol = trade.realSolReserves;
    launch.firstTradeAt ??= trade.timestamp || Date.now();
    launch.lastTradeAt = trade.receivedAt ?? Date.now();
    launch.lastSlot = trade.slot ?? null;
    launch.lastSignature = trade.signature ?? null;
    launch.lastSourceTimestamp = trade.timestamp || null;
    if (launch.detectedPriceUsd === null) launch.detectedPriceUsd = this.priceUsd(launch);
    this.emit(launch);
  }

  onComplete(mint: string) {
    const launch = this.launches.get(mint);
    if (launch) {
      launch.migrated = true;
      // The curve is closed: tell listeners (exit capacity records the route change).
      this.emit(launch);
    }
  }

  setExternal(mint: string, snapshot: TrackedLaunch['external']) {
    const launch = this.launches.get(mint);
    if (!launch || !snapshot) return;
    launch.external = snapshot;
    if (launch.detectedPriceUsd === null && snapshot.priceUsd) launch.detectedPriceUsd = snapshot.priceUsd;
    this.emit(launch);
  }

  private priceUsd(launch: TrackedLaunch): number | null {
    if (launch.virtualSol && launch.virtualToken && this.solUsd) return (launch.virtualSol / launch.virtualToken) * this.solUsd;
    return launch.external?.priceUsd ?? null;
  }

  /**
   * Liquidity: for a bonding curve the real SOL reserve valued in USD, doubled to be comparable with the
   * two-sided pool liquidity that DEX data reports; for pools the market-data liquidity.
   */
  private liquidityUsd(launch: TrackedLaunch): number | null {
    if (launch.realSol !== null && this.solUsd) return launch.realSol * this.solUsd * 2;
    return launch.external?.liquidityUsd ?? null;
  }

  /** Appends one observation per tracked token (called every ~2 s); prunes expired tokens. */
  observe(now: number) {
    for (const launch of [...this.launches.values()]) {
      if (!launch.keepAlive && now - launch.detectedAt > this.retentionMs) {
        this.launches.delete(launch.mint);
        continue;
      }
      const wallets = launch.wallets;
      const observation: LaunchObservation = wallets
        ? {
          takenAt: now,
          priceUsd: this.priceUsd(launch),
          liquidityUsd: this.liquidityUsd(launch),
          buyCount: launch.buyCount,
          sellCount: launch.sellCount,
          volumeUsd: this.solUsd ? (launch.buySol + launch.sellSol) * this.solUsd : 0,
          buyVolumeUsd: this.solUsd ? launch.buySol * this.solUsd : null,
          sellVolumeUsd: this.solUsd ? launch.sellSol * this.solUsd : null,
          uniqueBuyers: [...wallets.values()].filter((wallet) => wallet.buys > 0).length,
          uniqueSellers: [...wallets.values()].filter((wallet) => wallet.sells > 0).length,
        }
        : {
          takenAt: now,
          priceUsd: launch.external?.priceUsd ?? null,
          liquidityUsd: launch.external?.liquidityUsd ?? null,
          buyCount: launch.external?.buyCount ?? 0,
          sellCount: launch.external?.sellCount ?? 0,
          // Pools only report the total volume; the buy/sell split stays unknown (never split 50/50).
          volumeUsd: launch.external?.volumeUsd ?? 0,
          buyVolumeUsd: null,
          sellVolumeUsd: null,
          uniqueBuyers: null,
          uniqueSellers: null,
        };
      launch.observations.push(observation);
      if (launch.observations.length > 120) launch.observations.splice(0, launch.observations.length - 120);
    }
  }

  /** Strategy input for one token, including the price impact of the actual intended order size (USD). */
  state(mint: string, intendedOrderUsd: number | null): LaunchState | null {
    const launch = this.launches.get(mint);
    if (!launch) return null;
    const wallets = launch.wallets;
    let largestBuyerShare: number | null = null;
    let buysPerBuyer: number | null = null;
    let creatorSoldRatio: number | null = null;
    let largestHolderSupplyShare: number | null = null;
    let creatorHoldingShare: number | null = null;
    let observedSellers: number | null = null;
    if (wallets) {
      const buyers = [...wallets.values()].filter((wallet) => wallet.buys > 0);
      largestBuyerShare = launch.buySol > 0 ? Math.max(...buyers.map((wallet) => wallet.buySol)) / launch.buySol : null;
      buysPerBuyer = buyers.length ? launch.buyCount / buyers.length : null;
      const creator = launch.creator ? wallets.get(launch.creator) : undefined;
      creatorSoldRatio = creator && creator.buyTokens > 0 ? creator.sellTokens / creator.buyTokens : null;
      // Observed from the trade stream since creation; unknown when the creator is not known.
      creatorHoldingShare = launch.creator ? Math.max(0, (creator?.buyTokens ?? 0) - (creator?.sellTokens ?? 0)) / PUMP_FUN_TOTAL_SUPPLY : null;
      const holdings = [...wallets.values()].map((wallet) => Math.max(0, wallet.buyTokens - wallet.sellTokens));
      largestHolderSupplyShare = holdings.length ? Math.max(...holdings) / PUMP_FUN_TOTAL_SUPPLY : null;
      observedSellers = [...wallets.entries()].filter(([address, wallet]) => wallet.sells > 0 && address !== launch.creator).length;
    }
    return {
      mint,
      detectedAt: launch.detectedAt,
      createdAt: launch.createdAt,
      observations: launch.observations,
      largestBuyerShare,
      buysPerBuyer,
      creatorSoldRatio,
      largestHolderSupplyShare,
      creatorHoldingShare,
      priceImpactPercent: intendedOrderUsd ? this.impact(launch, intendedOrderUsd) : null,
      observedSellers,
    };
  }

  private impact(launch: TrackedLaunch, usd: number) {
    if (launch.virtualSol && launch.virtualToken && this.solUsd) return bondingCurveBuyImpactPercent(launch.virtualSol, launch.virtualToken, usd / this.solUsd);
    const liquidity = launch.external?.liquidityUsd;
    return liquidity && liquidity > 0 ? 0.1 + 100 * usd / (liquidity / 2 + usd) : null;
  }

  /** Live quote for PAPER execution and position monitoring (fresh trade-stream / market data only). */
  quote(mint: string, maxAgeMs = 60_000): LaunchQuote | null {
    const launch = this.launches.get(mint);
    if (!launch) return null;
    const price = this.priceUsd(launch);
    const updatedAt = launch.wallets ? launch.lastTradeAt : launch.external?.at ?? null;
    if (!price || !updatedAt || Date.now() - updatedAt > maxAgeMs) return null;
    return { priceUsd: price, liquidityUsd: this.liquidityUsd(launch), timestamp: new Date(updatedAt), streaming: Boolean(launch.wallets), impactPercentFor: (usd) => this.impact(launch, usd), curve: this.curveState(launch), migrated: launch.migrated };
  }

  /** Bonding-curve reserves (SOL / tokens) while the curve is live; null otherwise. */
  curveState(launch: TrackedLaunch): CurveState | null {
    if (launch.migrated || !launch.virtualSol || !launch.virtualToken || !this.solUsd) return null;
    return { virtualQuote: launch.virtualSol, virtualBase: launch.virtualToken, realQuote: launch.realSol, quoteUsd: this.solUsd };
  }

  private evictOldest() {
    let oldest: TrackedLaunch | null = null;
    for (const launch of this.launches.values()) if (!launch.keepAlive && (!oldest || launch.detectedAt < oldest.detectedAt)) oldest = launch;
    if (oldest) this.launches.delete(oldest.mint);
  }
}
