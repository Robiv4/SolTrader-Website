import crypto from 'node:crypto';

export type TelegramEvent = 'BOT_STARTED' | 'BOT_STOPPED' | 'TRADE_OPENED' | 'TRADE_CLOSED' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'DAILY_LOSS_LIMIT' | 'SYSTEM_ERROR' | 'RPC_FAILURE' | 'EXECUTION_FAILURE' | 'EMERGENCY_STOP';
export type HealthState = 'HEALTHY' | 'DEGRADED' | 'DOWN';
export type HealthComponent = 'API' | 'DATABASE' | 'REDIS' | 'RPC' | 'MARKET DATA' | 'EXECUTION ENGINE' | 'RISK ENGINE' | 'POSITION MANAGER' | 'TRADING ENGINE';

export interface MonitoringEnvironment {
  TELEGRAM_NOTIFICATIONS_ENABLED?: string | boolean;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_ALERT_THROTTLE_MS?: string | number;
}

export interface MonitoringEvent {
  event: string;
  correlationId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface MetricSample {
  component: string;
  metric: string;
  valueMs?: number;
  count?: number;
  timestamp: string;
  correlationId: string;
}

export interface HealthStatus {
  component: HealthComponent;
  state: HealthState;
  latencyMs?: number;
  message?: string;
  checkedAt: string;
}

const SECRET_KEYS = /private|password|token|secret|key|credential|authorization/i;

export function createCorrelationId(): string { return crypto.randomUUID(); }

export function sanitizeMetadata(data: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(data).filter(([key]) => !SECRET_KEYS.test(key)));
}

export function formatTelegramMessage(event: TelegramEvent, data: Record<string, unknown>, correlationId: string) {
  const safe = sanitizeMetadata(data);
  const details = Object.entries(safe).map(([key, value]) => `${key}: ${String(value)}`).join('\n');
  return [`[${event}]`, `correlation_id: ${correlationId}`, details].filter(Boolean).join('\n');
}

export class TelegramNotifier {
  private readonly lastSent = new Map<TelegramEvent, number>();
  private readonly throttleMs: number;

  constructor(private readonly environment: MonitoringEnvironment = process.env, private readonly fetcher: typeof globalThis.fetch = globalThis.fetch) {
    this.throttleMs = Number(environment.TELEGRAM_ALERT_THROTTLE_MS ?? 60_000);
  }

  get enabled() {
    return environmentBoolean(this.environment.TELEGRAM_NOTIFICATIONS_ENABLED) && Boolean(this.environment.TELEGRAM_BOT_TOKEN && this.environment.TELEGRAM_CHAT_ID);
  }

  async notify(event: TelegramEvent, data: Record<string, unknown>, correlationId = createCorrelationId()) {
    if (!this.enabled) return { sent: false, reason: 'disabled' as const };
    const last = this.lastSent.get(event) ?? 0;
    if (Date.now() - last < this.throttleMs) return { sent: false, reason: 'throttled' as const };
    const response = await this.fetcher(`https://api.telegram.org/bot${this.environment.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: this.environment.TELEGRAM_CHAT_ID, text: formatTelegramMessage(event, data, correlationId) }),
    });
    if (!response.ok) throw new Error(`Telegram notification failed with HTTP ${response.status}`);
    this.lastSent.set(event, Date.now());
    return { sent: true, reason: 'sent' as const };
  }
}

function environmentBoolean(value: string | boolean | undefined) { return value === true || value?.toString().toLowerCase() === 'true'; }

export class MonitoringRegistry {
  private readonly events: MonitoringEvent[] = [];
  private readonly metrics: MetricSample[] = [];
  private readonly health = new Map<HealthComponent, HealthStatus>();

  record(event: string, data: Record<string, unknown> = {}, correlationId = createCorrelationId()) {
    const item = { event, correlationId, timestamp: new Date().toISOString(), data: sanitizeMetadata(data) };
    this.events.push(item);
    return item;
  }

  measure(component: string, metric: string, startedAt: number, correlationId: string, count?: number) {
    const sample = { component, metric, valueMs: Date.now() - startedAt, count, timestamp: new Date().toISOString(), correlationId };
    this.metrics.push(sample);
    return sample;
  }

  setHealth(component: HealthComponent, state: HealthState, details: Omit<HealthStatus, 'component' | 'state' | 'checkedAt'> = {}) {
    const status = { component, state, ...details, checkedAt: new Date().toISOString() };
    this.health.set(component, status);
    return status;
  }

  snapshot() { return { events: [...this.events], metrics: [...this.metrics], health: [...this.health.values()] }; }
}

export async function checkHealth(component: HealthComponent, probe: () => Promise<void>, registry: MonitoringRegistry) {
  const startedAt = Date.now();
  try {
    await probe();
    const latencyMs = Date.now() - startedAt;
    registry.setHealth(component, 'HEALTHY', { latencyMs });
    return registry.setHealth(component, 'HEALTHY', { latencyMs });
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    return registry.setHealth(component, 'DOWN', { latencyMs, message: error instanceof Error ? error.message : String(error) });
  }
}
