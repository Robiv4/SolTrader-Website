import { describe, expect, it } from 'vitest';

import { MonitoringRegistry, TelegramNotifier, formatTelegramMessage, sanitizeMetadata } from '../src/index.js';

describe('monitoring', () => {
  it('removes secrets from structured metadata and Telegram messages', () => {
    const safe = sanitizeMetadata({ symbol: 'TKN', password: 'hidden', privateKey: 'hidden', amount: 1 });
    expect(safe).toEqual({ symbol: 'TKN', amount: 1 });
    const message = formatTelegramMessage('TRADE_OPENED', { symbol: 'TKN', sessionToken: 'hidden' }, 'corr-1');
    expect(message).toContain('symbol: TKN');
    expect(message).not.toContain('hidden');
  });

  it('throttles repeated Telegram events and remains optional', async () => {
    let calls = 0;
    const notifier = new TelegramNotifier({ TELEGRAM_NOTIFICATIONS_ENABLED: 'true', TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_CHAT_ID: 'chat', TELEGRAM_ALERT_THROTTLE_MS: '60000' }, (async () => { calls += 1; return { ok: true, status: 200 }; }) as never);
    await expect(notifier.notify('RPC_FAILURE', { message: 'down' }, 'corr')).resolves.toMatchObject({ sent: true });
    await expect(notifier.notify('RPC_FAILURE', { message: 'down' }, 'corr')).resolves.toMatchObject({ sent: false, reason: 'throttled' });
    expect(calls).toBe(1);
    const disabled = new TelegramNotifier({ TELEGRAM_NOTIFICATIONS_ENABLED: 'false' });
    await expect(disabled.notify('BOT_STARTED', {}, 'corr')).resolves.toMatchObject({ sent: false, reason: 'disabled' });
  });

  it('stores health, latency, and structured events', () => {
    const registry = new MonitoringRegistry();
    registry.record('strategy_decision', { strategy: 'MomentumStrategy' }, 'corr');
    registry.measure('RPC', 'rpc_latency', Date.now() - 4, 'corr');
    registry.setHealth('RPC', 'DEGRADED', { message: 'slow' });
    expect(registry.snapshot().events).toHaveLength(1);
    expect(registry.snapshot().metrics[0].component).toBe('RPC');
    expect(registry.snapshot().health[0].state).toBe('DEGRADED');
  });
});
