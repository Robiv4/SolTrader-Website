export type BotMode = 'PAPER' | 'LIVE' | 'SEMI_AUTO' | 'SCANNER';

export interface ApiErrorResponse {
  ok: boolean;
  error: string;
  details?: unknown;
}

export interface ApiSuccessResponse<T> {
  ok: true;
  data: T;
}
