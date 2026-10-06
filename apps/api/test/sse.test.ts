import { describe, expect, it } from 'vitest';

import { redactSensitiveFields } from '../src/secret-redaction.js';
import { canReceiveRealtimePayload } from '../src/sse.js';

describe('SSE tenant isolation', () => {
  it('delivers an owned event only to that user', () => {
    const payload = { type: 'position_update', payload: { userId: 'user-a', positionId: 'position-a' } };
    expect(canReceiveRealtimePayload({ userId: 'user-a', role: 'USER' }, payload)).toBe(true);
    expect(canReceiveRealtimePayload({ userId: 'user-b', role: 'USER' }, payload)).toBe(false);
  });

  it('keeps ownerless platform events admin-only', () => {
    const payload = { type: 'new_log', payload: { message: 'platform event' } };
    expect(canReceiveRealtimePayload({ userId: 'user-a', role: 'USER' }, payload)).toBe(false);
    expect(canReceiveRealtimePayload({ userId: 'admin', role: 'ADMIN' }, payload)).toBe(true);
  });

  it('allows administrators to review tenant events', () => {
    expect(canReceiveRealtimePayload(
      { userId: 'admin', role: 'ADMIN' },
      { payload: { data: { userId: 'user-a', tradeId: 'trade-a' } } },
    )).toBe(true);
  });

  it('redacts nested secret-like values before realtime delivery', () => {
    expect(redactSensitiveFields({ payload: { sessionToken: 'hidden', nested: { privateKey: 'hidden', visible: 'ok' } } })).toEqual({
      payload: { sessionToken: '[REDACTED]', nested: { privateKey: '[REDACTED]', visible: 'ok' } },
    });
  });
});
