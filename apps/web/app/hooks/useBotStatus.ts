'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import useSWR from 'swr';

import { apiRequest } from '../components';

import { useRealtimeEvents } from './useRealtimeEvents';

export type BotStatus = 'RUNNING' | 'PAUSED' | 'STOPPED' | 'EMERGENCY_STOP';

export interface BotStateResponse {
  data: {
    botState: { id: string; status: BotStatus; updatedAt: string; updatedBy?: string | null } | null;
    activeStrategies: Array<{ id: string; strategyName: string; isEnabled: boolean; configJson: Record<string, unknown>; maxExposure?: number | null; maxPositions?: number | null }>;
  };
}

export function useBotStatus() {
  const router = useRouter();
  const fetcher = async (path: string) => {
    try {
      return await apiRequest<BotStateResponse>(path);
    } catch (error) {
      if (error instanceof Error && (error.message === 'Authentication required' || error.message === 'Session expired or invalid')) router.push('/login');
      throw error;
    }
  };
  const { mutate, ...result } = useSWR<BotStateResponse>('/api/bot/status', fetcher, { refreshInterval: 5000, revalidateOnFocus: true });
  const { lastEvent } = useRealtimeEvents(['status_change']);

  useEffect(() => {
    if (lastEvent) void mutate();
  }, [lastEvent, mutate]);

  async function command(action: 'start' | 'pause' | 'stop' | 'emergency-stop') {
    await apiRequest(`/api/bot/${action}`, { method: 'POST', body: '{}' });
    await mutate();
  }

  return { ...result, botState: result.data?.data.botState ?? null, activeStrategies: result.data?.data.activeStrategies ?? [], command };
}
