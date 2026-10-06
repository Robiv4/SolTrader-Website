import type { RealtimeEvent, RealtimeEventType } from '@soltrader/shared';
import type { Request, Response } from 'express';
import { createClient } from 'redis';

import { env } from './config.js';
import { logger } from './logger.js';
import { redactSensitiveFields } from './secret-redaction.js';

type RedisClient = ReturnType<typeof createClient>;
type SseClient = Response;
export interface SsePrincipal { userId: string; role: string }

const CHANNELS = ['bot:events', 'bot:logs', 'bot:positions', 'bot:trades', 'bot:pnl', 'bot:risk', 'bot:tokens', 'bot:signals', 'bot:decisions', 'bot:launches'];
const channelEventTypes: Record<(typeof CHANNELS)[number], RealtimeEventType> = {
  'bot:events': 'status_change',
  'bot:logs': 'new_log',
  'bot:positions': 'position_update',
  'bot:trades': 'trade_update',
  'bot:pnl': 'pnl_update',
  'bot:risk': 'risk_update',
  'bot:tokens': 'token_update',
  'bot:signals': 'signal_update',
  'bot:decisions': 'decision_update',
  'bot:launches': 'launch_update',
};

export class SseEventHub {
  private readonly clients = new Map<SseClient, SsePrincipal>();
  private readonly subscriber: RedisClient;
  private started = false;
  private heartbeat?: ReturnType<typeof globalThis.setInterval>;

  constructor() {
    const publisher = createClient({ url: env.REDIS_URL, ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}) });
    this.subscriber = publisher.duplicate();
    this.subscriber.on('error', (error) => logger.error({ err: error }, 'SSE Redis subscriber error'));
  }

  async start() {
    if (this.started) return;
    await this.subscriber.connect();
    await this.subscriber.subscribe([...CHANNELS], (message, channel) => {
      const eventType = channelEventTypes[channel as (typeof CHANNELS)[number]];
      if (eventType) this.broadcast(eventType, message);
    });
    this.heartbeat = globalThis.setInterval(() => {
      for (const client of this.clients.keys()) client.write(': ping\n\n');
    }, 15_000);
    this.started = true;
  }

  async handle(req: Request, res: Response, principal: SsePrincipal) {
    try {
      await this.start();
    } catch (error) {
      logger.error({ err: error }, 'Unable to start SSE Redis subscriber');
      return res.status(503).json({ ok: false, error: 'Realtime event stream unavailable' });
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': connected\n\n');
    this.clients.set(res, principal);

    const removeClient = () => {
      this.clients.delete(res);
      res.removeListener('close', removeClient);
    };
    req.on('close', removeClient);
    return res;
  }

  async stop() {
    if (this.heartbeat) globalThis.clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.clients.clear();
    if (this.started) await this.subscriber.quit();
    this.started = false;
  }

  private broadcast(type: RealtimeEventType, rawPayload: string) {
    let payload: unknown = rawPayload;
    try {
      payload = JSON.parse(rawPayload) as unknown;
    } catch {
      logger.warn({ type }, 'SSE Redis message was not valid JSON');
    }
    payload = redactSensitiveFields(payload);
    const event: RealtimeEvent = { type, payload, timestamp: new Date().toISOString() };
    const wire = `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const [client, principal] of this.clients) {
      if (!canReceiveRealtimePayload(principal, payload)) continue;
      try {
        client.write(wire);
      } catch (error) {
        logger.warn({ err: error, type }, 'Failed to write SSE event');
        this.clients.delete(client);
      }
    }
  }
}

function payloadOwner(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.userId === 'string') return record.userId;
  return payloadOwner(record.payload) ?? payloadOwner(record.data);
}

export function canReceiveRealtimePayload(principal: SsePrincipal, payload: unknown) {
  const ownerId = payloadOwner(payload);
  return ownerId ? principal.role === 'ADMIN' || ownerId === principal.userId : principal.role === 'ADMIN';
}
