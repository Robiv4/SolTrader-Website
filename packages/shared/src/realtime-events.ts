export type RealtimeEventType = 'status_change' | 'new_log' | 'position_update' | 'trade_update' | 'pnl_update' | 'risk_update' | 'token_update' | 'signal_update' | 'decision_update' | 'launch_update';

export interface RealtimeEvent<TPayload = unknown> {
  type: RealtimeEventType;
  payload: TPayload;
  timestamp: string;
  correlationId?: string;
}
