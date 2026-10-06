'use client';

import { useEffect, useState } from 'react';

import { EmptyState, ErrorState, useApi } from './components';
import { useRealtimeEvents } from './hooks/useRealtimeEvents';

type LogEntry = { id: string; action: string; details: unknown; createdAt: string; source?: string };

function summarize(details: unknown) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return typeof details === 'string' ? details : '';
  const record = details as Record<string, unknown>;
  const preferred = ['symbol', 'tokenAddress', 'exitReason', 'reason', 'status', 'finalDecision', 'decisionReasons', 'netPnl', 'publicAddress', 'strategyName', 'email', 'fields'];
  const parts = preferred
    .filter((key) => record[key] !== undefined && record[key] !== null && record[key] !== '')
    .map((key) => `${key}: ${Array.isArray(record[key]) ? (record[key] as unknown[]).join(', ') : typeof record[key] === 'object' ? JSON.stringify(record[key]) : String(record[key])}`);
  return parts.length ? parts.join(' · ') : JSON.stringify(record);
}

/**
 * Audit trail viewer: loads the persisted audit log, then prepends entries streamed live from the
 * API and the worker over SSE (Redis channel bot:logs).
 */
export function LiveLogViewer({ limit = 200 }: { limit?: number }) {
  const { data, error, loading } = useApi<{ data: LogEntry[] }>(`/api/audit-logs?limit=${Math.min(limit, 200)}`);
  const { connectionState, lastEvent } = useRealtimeEvents(['new_log']);
  const [live, setLive] = useState<LogEntry[]>([]);

  useEffect(() => {
    if (!lastEvent) return;
    const payload = lastEvent.payload && typeof lastEvent.payload === 'object' ? lastEvent.payload as Partial<LogEntry> : {};
    const entry: LogEntry = {
      id: payload.id ?? `${lastEvent.timestamp}-${Math.random().toString(36).slice(2)}`,
      action: payload.action ?? 'EVENT',
      details: payload.details ?? lastEvent.payload,
      createdAt: payload.createdAt ?? lastEvent.timestamp,
      source: payload.source,
    };
    setLive((current) => [entry, ...current.filter((item) => item.id !== entry.id)].slice(0, limit));
  }, [lastEvent, limit]);

  const persisted = data?.data ?? [];
  const seen = new Set(live.map((entry) => entry.id));
  const entries = [...live, ...persisted.filter((entry) => !seen.has(entry.id))].slice(0, limit);

  return <div className="live-log-viewer">
    <div className="live-log-toolbar"><span>Auditnapló · élő</span><span className={`stream-state ${connectionState.toLowerCase()}`}>{connectionState}</span></div>
    {error && !data ? <ErrorState message={error} /> : <div className="live-log-list">{loading && !data
      ? <EmptyState message="Napló betöltése…" />
      : entries.length === 0
        ? <EmptyState message="Még nincs naplóbejegyzés." />
        : entries.map((entry) => <div className="live-log-line" key={entry.id}>
          <time title={new Date(entry.createdAt).toLocaleString('hu-HU')}>{new Date(entry.createdAt).toLocaleTimeString('hu-HU')}</time>
          <code><strong>{entry.action}</strong>{entry.source ? ` [${entry.source}]` : ''} {summarize(entry.details)}</code>
        </div>)}</div>}
  </div>;
}
