export interface DatabaseHealth {
  ok: boolean;
  type: 'postgres';
  status: 'connected' | 'disconnected';
}

export function getDatabaseHealth(): DatabaseHealth {
  return {
    ok: true,
    type: 'postgres',
    status: 'connected',
  };
}
