import request from 'supertest';
import { describe, expect, it } from 'vitest';

const { app } = await import('../src/app.js');

describe('sensitive endpoint rate limits', () => {
  it('limits repeated unsuccessful authentication attempts', async () => {
    const responses = await Promise.all(Array.from({ length: 12 }, () => request(app).post('/api/auth/login').send({})));
    expect(responses.some((response) => response.status === 429)).toBe(true);
    expect(responses.every((response) => response.status === 400 || response.status === 429)).toBe(true);
  });
});

describe('dashboard polling does not starve trading actions', () => {
  it('keeps the write budget available after a burst of reads', async () => {
    const reads = await Promise.all(Array.from({ length: 150 }, () => request(app).get('/api/bot/status')));
    // 150 reads exceed the former 120/min shared limit but stay far below the read budget.
    expect(reads.some((response) => response.status === 429)).toBe(false);
    const write = await request(app).post('/api/bot/start').send({});
    expect(write.status).not.toBe(429);
  });
});
