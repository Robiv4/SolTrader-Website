'use client';

import type { RealtimeEvent, RealtimeEventType } from '@soltrader/shared';
import { useEffect, useRef, useState } from 'react';

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export type RealtimeConnectionState = 'CONNECTING' | 'OPEN' | 'CLOSED';

export function useRealtimeEvents(types?: RealtimeEventType[]) {
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>('CONNECTING');
  const [lastEvent, setLastEvent] = useState<RealtimeEvent | null>(null);
  const retryTimer = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const retryAttempt = useRef(0);
  const typeKey = types?.join(',') ?? '*';

  useEffect(() => {
    let disposed = false;
    let source: globalThis.EventSource | undefined;
    const eventTypes = types ?? ['status_change', 'new_log', 'position_update', 'trade_update', 'pnl_update', 'risk_update', 'token_update', 'signal_update', 'decision_update'];

    const connect = () => {
      if (disposed) return;
      setConnectionState('CONNECTING');
      source = new globalThis.EventSource(`${apiBase}/api/stream/events`, { withCredentials: true });
      const onEvent = (event: globalThis.MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(event.data) as RealtimeEvent;
          if (eventTypes.includes(parsed.type)) setLastEvent(parsed);
        } catch {
          // Ignore malformed server events and keep the stream alive.
        }
      };
      eventTypes.forEach((type) => source?.addEventListener(type, onEvent));
      source.onopen = () => { retryAttempt.current = 0; setConnectionState('OPEN'); };
      source.onerror = () => {
        source?.close();
        if (disposed) return;
        setConnectionState('CLOSED');
        const delay = Math.min(30_000, 1_000 * 2 ** retryAttempt.current);
        retryAttempt.current += 1;
        retryTimer.current = globalThis.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      disposed = true;
      source?.close();
      if (retryTimer.current) globalThis.clearTimeout(retryTimer.current);
    };
  }, [typeKey]);

  return { connectionState, lastEvent };
}
