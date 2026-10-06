import { createHash } from 'node:crypto';

import type { TradingLoopLogger } from '../trading-loop.js';

export const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const RAYDIUM_AMM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

export type LaunchSource = 'PUMP_FUN' | 'RAYDIUM' | 'METEORA';
export type ProviderState = 'ACTIVE' | 'CONNECTING' | 'DEGRADED' | 'UNAVAILABLE' | 'NOT_CONFIGURED';

export interface LaunchProviderStatus {
  source: LaunchSource;
  label: string;
  status: ProviderState;
  detail: string | null;
  lastEventAt: string | null;
  events: number;
}

export interface LaunchEvent {
  source: LaunchSource;
  mint: string;
  detectedAt: number;
  /** On-chain time of the creating transaction when known (ms). */
  createdAt: number | null;
  bondingCurve: string | null;
  poolAddress: string | null;
  quoteMint: string | null;
  creator: string | null;
  name: string | null;
  symbol: string | null;
  /** Token metadata URI (pump.fun create event); social links are resolved from it. */
  metadataUri?: string | null;
}

export interface LaunchTradeEvent {
  mint: string;
  wallet: string;
  isBuy: boolean;
  solAmount: number;
  tokenAmount: number;
  timestamp: number;
  virtualSolReserves: number;
  virtualTokenReserves: number;
  realSolReserves: number;
  /** Stream provenance (ordering / latency diagnostics). */
  slot?: number | null;
  signature?: string | null;
  receivedAt?: number;
}

export interface LaunchHandlers {
  onLaunch(event: LaunchEvent): void;
  onTrade?(event: LaunchTradeEvent): void;
  onComplete?(mint: string): void;
}

/** Discovery provider contract (event-driven where possible). */
export interface NewLaunchProvider {
  readonly source: LaunchSource;
  subscribe(handlers: LaunchHandlers): void;
  unsubscribe(): void;
  healthCheck(): LaunchProviderStatus;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes: Uint8Array) {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
  let out = '';
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const discriminator = (name: string) => createHash('sha256').update(`event:${name}`).digest().subarray(0, 8).toString('hex');
const CREATE_EVENT = discriminator('CreateEvent');
const TRADE_EVENT = discriminator('TradeEvent');
const COMPLETE_EVENT = discriminator('CompleteEvent');

export type PumpFunEvent =
  | { type: 'create'; name: string; symbol: string; uri: string; mint: string; bondingCurve: string; user: string; creator: string | null; timestamp: number | null }
  | ({ type: 'trade' } & LaunchTradeEvent)
  | { type: 'complete'; mint: string };

/** Decodes one pump.fun Anchor event ("Program data: <base64>" log line). Returns null for other events. */
export function decodePumpFunEvent(base64: string): PumpFunEvent | null {
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length < 8) return null;
  const kind = buffer.subarray(0, 8).toString('hex');
  let offset = 8;
  const key = () => {
    const value = base58(buffer.subarray(offset, offset + 32));
    offset += 32;
    return value;
  };
  const u64 = () => {
    const value = Number(buffer.readBigUInt64LE(offset));
    offset += 8;
    return value;
  };
  try {
    if (kind === CREATE_EVENT) {
      const text = () => {
        const length = buffer.readUInt32LE(offset);
        offset += 4;
        const value = buffer.subarray(offset, offset + length).toString('utf8');
        offset += length;
        return value;
      };
      const name = text();
      const symbol = text();
      const uri = text();
      const mint = key();
      const bondingCurve = key();
      const user = key();
      // Newer layouts append the creator and a unix timestamp.
      const creator = buffer.length >= offset + 32 ? key() : null;
      const timestamp = buffer.length >= offset + 8 ? Number(buffer.readBigInt64LE(offset)) * 1000 : null;
      return { type: 'create', name, symbol, uri, mint, bondingCurve, user, creator, timestamp: timestamp && timestamp > 1.6e12 && timestamp < 4e12 ? timestamp : null };
    }
    if (kind === TRADE_EVENT) {
      const mint = key();
      const solAmount = u64() / 1e9;
      const tokenAmount = u64() / 1e6;
      const isBuy = buffer[offset] === 1;
      offset += 1;
      const wallet = key();
      const timestamp = Number(buffer.readBigInt64LE(offset)) * 1000;
      offset += 8;
      const virtualSolReserves = u64() / 1e9;
      const virtualTokenReserves = u64() / 1e6;
      const realSolReserves = u64() / 1e9;
      return { type: 'trade', mint, wallet, isBuy, solAmount, tokenAmount, timestamp, virtualSolReserves, virtualTokenReserves, realSolReserves };
    }
    if (kind === COMPLETE_EVENT) {
      offset += 32; // user
      return { type: 'complete', mint: key() };
    }
  } catch {
    return null;
  }
  return null;
}

type WebSocketLike = {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
};
export type WebSocketFactory = (url: string) => WebSocketLike;

const defaultWebSocketFactory: WebSocketFactory = (url) => new (globalThis as unknown as { WebSocket: new (url: string) => WebSocketLike }).WebSocket(url);

/** Solana `logsSubscribe` for one program with automatic reconnect (exponential backoff). */
export class ProgramLogsSubscription {
  private socket: WebSocketLike | null = null;
  private stopped = true;
  private retries = 0;
  private timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  state: ProviderState = 'CONNECTING';
  detail: string | null = null;
  lastEventAt: number | null = null;
  events = 0;

  constructor(
    private readonly url: string,
    private readonly programId: string,
    private readonly onLogs: (value: { signature: string; err: unknown; logs: string[] }, context: { slot: number | null; receivedAt: number }) => void,
    private readonly logger: TradingLoopLogger,
    private readonly factory: WebSocketFactory = defaultWebSocketFactory,
  ) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) globalThis.clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
  }

  private connect() {
    if (this.stopped) return;
    this.state = this.retries === 0 ? 'CONNECTING' : 'DEGRADED';
    let socket: WebSocketLike;
    try {
      socket = this.factory(this.url);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'WebSocket unavailable');
      return;
    }
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [this.programId] }, { commitment: 'confirmed' }] }));
    socket.onmessage = (event) => {
      const receivedAt = Date.now();
      let message: { id?: number; result?: unknown; error?: { message?: string }; params?: { result?: { context?: { slot?: number }; value?: { signature: string; err: unknown; logs: string[] } } } };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id === 1) {
        if (message.error) this.fail(message.error.message ?? 'subscribe failed');
        else {
          this.state = 'ACTIVE';
          this.detail = null;
          this.retries = 0;
        }
        return;
      }
      const value = message.params?.result?.value;
      if (!value) return;
      this.lastEventAt = receivedAt;
      try {
        this.onLogs(value, { slot: typeof message.params?.result?.context?.slot === 'number' ? message.params.result.context.slot : null, receivedAt });
      } catch (error) {
        this.logger.warn({ err: error instanceof Error ? error.message : String(error), programId: this.programId }, 'Launch log handling failed');
      }
    };
    socket.onerror = () => {
      this.detail = 'WebSocket hiba';
    };
    socket.onclose = () => {
      if (this.socket === socket) this.fail(this.detail ?? 'Kapcsolat megszakadt');
    };
  }

  private fail(reason: string) {
    this.socket = null;
    this.retries += 1;
    this.state = this.retries >= 5 ? 'UNAVAILABLE' : 'DEGRADED';
    this.detail = reason;
    if (this.stopped) return;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(this.retries, 6));
    this.logger.warn({ programId: this.programId, retries: this.retries, delay, reason }, 'Launch provider reconnecting');
    this.timer = globalThis.setTimeout(() => this.connect(), delay);
  }
}

/** Pump.fun: new bonding-curve tokens and every trade, event-driven from program logs (no polling). */
export class PumpFunLaunchProvider implements NewLaunchProvider {
  readonly source = 'PUMP_FUN' as const;
  private subscription: ProgramLogsSubscription | null = null;

  constructor(private readonly wsUrl: string | null, private readonly logger: TradingLoopLogger, private readonly factory?: WebSocketFactory) {}

  subscribe(handlers: LaunchHandlers) {
    if (!this.wsUrl) return;
    this.subscription = new ProgramLogsSubscription(this.wsUrl, PUMP_FUN_PROGRAM_ID, (value, context) => {
      if (value.err) return;
      const detectedAt = context.receivedAt;
      for (const line of value.logs) {
        if (!line.startsWith('Program data: ')) continue;
        const event = decodePumpFunEvent(line.slice(14));
        if (!event) continue;
        if (this.subscription) this.subscription.events += 1;
        if (event.type === 'create') {
          handlers.onLaunch({ source: 'PUMP_FUN', mint: event.mint, detectedAt, createdAt: event.timestamp, bondingCurve: event.bondingCurve, poolAddress: event.bondingCurve, quoteMint: WSOL_MINT, creator: event.creator ?? event.user, name: event.name, symbol: event.symbol, metadataUri: event.uri });
        } else if (event.type === 'trade') {
          handlers.onTrade?.({ ...event, slot: context.slot, signature: value.signature, receivedAt: context.receivedAt });
        } else {
          handlers.onComplete?.(event.mint);
        }
      }
    }, this.logger, this.factory);
    this.subscription.start();
  }

  unsubscribe() {
    this.subscription?.stop();
    this.subscription = null;
  }

  healthCheck(): LaunchProviderStatus {
    if (!this.wsUrl) return { source: this.source, label: 'Pump.fun', status: 'NOT_CONFIGURED', detail: 'SOLANA_WS_URL nincs beállítva', lastEventAt: null, events: 0 };
    const sub = this.subscription;
    return { source: this.source, label: 'Pump.fun', status: sub?.state ?? 'CONNECTING', detail: sub?.detail ?? null, lastEventAt: sub?.lastEventAt ? new Date(sub.lastEventAt).toISOString() : null, events: sub?.events ?? 0 };
  }
}

/** JSON-RPC call function (provided by the shared SolanaRpcManager). */
type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * Raydium AMM v4: "initialize2" (new pool) events from program logs; the pool/mint accounts are read from the
 * confirmed transaction (accounts 4 = pool, 8 = coin mint, 9 = pc mint). Activity data comes from market data.
 */
export class RaydiumLaunchProvider implements NewLaunchProvider {
  readonly source = 'RAYDIUM' as const;
  private subscription: ProgramLogsSubscription | null = null;
  private readonly queue: Array<{ signature: string; detectedAt: number }> = [];
  private busy = false;
  private failures = 0;

  constructor(private readonly wsUrl: string | null, private readonly rpc: RpcCall | null, private readonly logger: TradingLoopLogger, private readonly factory?: WebSocketFactory) {}

  subscribe(handlers: LaunchHandlers) {
    if (!this.wsUrl || !this.rpc) return;
    this.subscription = new ProgramLogsSubscription(this.wsUrl, RAYDIUM_AMM_V4_PROGRAM_ID, (value) => {
      if (value.err || !value.logs.some((line) => /initialize2/i.test(line))) return;
      if (this.queue.length < 20) this.queue.push({ signature: value.signature, detectedAt: Date.now() });
      void this.drain(handlers);
    }, this.logger, this.factory);
    this.subscription.start();
  }

  private async drain(handlers: LaunchHandlers) {
    if (this.busy || !this.rpc) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        try {
          const tx = await this.rpc('getTransaction', [item.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]) as { blockTime?: number; transaction?: { message?: { instructions?: Array<{ programId?: string; accounts?: string[] }> } } } | null;
          const instruction = tx?.transaction?.message?.instructions?.find((entry) => entry.programId === RAYDIUM_AMM_V4_PROGRAM_ID && (entry.accounts?.length ?? 0) >= 18);
          if (!instruction?.accounts) continue;
          const pool = instruction.accounts[4];
          const coin = instruction.accounts[8];
          const pc = instruction.accounts[9];
          const [mint, quote] = QUOTE_MINTS.has(coin) ? [pc, coin] : [coin, pc];
          if (QUOTE_MINTS.has(mint)) continue;
          if (this.subscription) this.subscription.events += 1;
          this.failures = 0;
          handlers.onLaunch({ source: 'RAYDIUM', mint, detectedAt: item.detectedAt, createdAt: tx?.blockTime ? tx.blockTime * 1000 : null, bondingCurve: null, poolAddress: pool, quoteMint: quote, creator: null, name: null, symbol: null });
        } catch (error) {
          this.failures += 1;
          this.logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'Raydium launch transaction lookup failed');
        }
      }
    } finally {
      this.busy = false;
    }
  }

  unsubscribe() {
    this.subscription?.stop();
    this.subscription = null;
  }

  healthCheck(): LaunchProviderStatus {
    if (!this.wsUrl || !this.rpc) return { source: this.source, label: 'Raydium', status: 'NOT_CONFIGURED', detail: 'Solana RPC/WS nincs beállítva', lastEventAt: null, events: 0 };
    const sub = this.subscription;
    const status = this.failures >= 5 && sub?.state === 'ACTIVE' ? 'DEGRADED' : sub?.state ?? 'CONNECTING';
    return { source: this.source, label: 'Raydium', status, detail: this.failures >= 5 ? 'Tranzakció-lekérés sikertelen (RPC limit?)' : sub?.detail ?? null, lastEventAt: sub?.lastEventAt ? new Date(sub.lastEventAt).toISOString() : null, events: sub?.events ?? 0 };
  }
}

/** Meteora: pool-creation decoding is not implemented reliably yet, so the provider reports NOT_CONFIGURED. */
export class MeteoraLaunchProvider implements NewLaunchProvider {
  readonly source = 'METEORA' as const;
  subscribe() {}
  unsubscribe() {}
  healthCheck(): LaunchProviderStatus {
    return { source: this.source, label: 'Meteora', status: 'NOT_CONFIGURED', detail: 'Megbízható pool-létrehozás dekódolás még nincs implementálva', lastEventAt: null, events: 0 };
  }
}
