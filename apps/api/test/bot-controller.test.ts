import type { PrismaClient } from '@prisma/client';
import { BotCommandPublisher } from '@soltrader/shared';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createBotController, type BotControllerDependencies } from '../src/bot-controller.js';

type BotConfigUpsertArgs = {
  where: { userId: string };
  update: Record<string, unknown>;
  create: Record<string, unknown>;
};

function fixture(isEmergencyStop = false) {
  const botConfigUpsert = vi.fn(async (args: BotConfigUpsertArgs) => ({ id: 'config-1', ...args.create, ...args.update }));
  const botConfigFindUnique = vi.fn(async () => isEmergencyStop ? { isEmergencyStop: true, tradingMode: 'PAPER', isLiveEnabled: false } : null);
  const botStateUpsert = vi.fn(async () => ({ id: 'default-bot', status: 'RUNNING' }));
  const publish = vi.fn(async () => 1);
  const logAuditEvent = vi.fn(async () => undefined);
  const dependencies = {
    prisma: {
      botConfig: { findUnique: botConfigFindUnique, upsert: botConfigUpsert },
      botState: { upsert: botStateUpsert },
    } as unknown as PrismaClient,
    getPublisher: async () => new BotCommandPublisher({ publish }),
    logAuditEvent,
    logger: { error: vi.fn() },
  } satisfies BotControllerDependencies;
  const controller = createBotController(dependencies);
  const req = { user: { id: 'owner-1', email: 'owner@example.invalid', role: 'ADMIN' } } as Request;
  const responseState: { statusCode: number; body?: unknown } = { statusCode: 200 };
  const res = {
    status(code: number) { responseState.statusCode = code; return this; },
    json(body: unknown) { responseState.body = body; return this; },
  } as unknown as Response;
  return { controller, req, res, responseState, botConfigUpsert, botConfigFindUnique, botStateUpsert, publish, logAuditEvent };
}

describe('bot controller persistence', () => {
  it("persists the owner's RUNNING BotConfig before publishing START", async () => {
    const test = fixture();
    await test.controller.start(test.req, test.res);

    expect(test.botConfigUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'owner-1' },
      update: expect.objectContaining({ status: 'RUNNING' }),
      create: expect.objectContaining({ userId: 'owner-1', status: 'RUNNING', tradingMode: 'PAPER' }),
    }));
    expect(test.botStateUpsert).toHaveBeenCalled();
    expect(test.publish).toHaveBeenCalledOnce();
    expect(test.responseState.statusCode).toBe(200);
  });

  it('does not start a user bot while its emergency stop is latched', async () => {
    const test = fixture(true);
    await test.controller.start(test.req, test.res);

    expect(test.botConfigUpsert).not.toHaveBeenCalled();
    expect(test.botStateUpsert).not.toHaveBeenCalled();
    expect(test.publish).not.toHaveBeenCalled();
    expect(test.responseState.statusCode).toBe(409);
  });
});
