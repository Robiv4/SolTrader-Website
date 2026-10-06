import type { Prisma, PrismaClient } from '@prisma/client';
import { BotCommandPublisher, type BotCommandPayload } from '@soltrader/shared';
import type { Request, Response } from 'express';

import { redactSensitiveFields } from './secret-redaction.js';

export interface BotControllerDependencies {
  prisma: PrismaClient;
  getPublisher: () => Promise<BotCommandPublisher>;
  logAuditEvent: (action: string, userId: string | null, details?: Record<string, unknown>) => Promise<unknown>;
  logger: { error(bindings: object, message: string): void };
}

const BOT_STATE_ID = 'default-bot';

function failure(res: Response, message: string) {
  return res.status(503).json({
    ok: false,
    error: message,
  });
}

async function updateState(dependencies: BotControllerDependencies, status: 'RUNNING' | 'PAUSED' | 'STOPPED' | 'EMERGENCY_STOP', updatedBy: string) {
  return dependencies.prisma.botState.upsert({
    where: { id: BOT_STATE_ID },
    update: { status, updatedBy },
    create: { id: BOT_STATE_ID, status, updatedBy },
  });
}

async function publish(dependencies: BotControllerDependencies, command: Parameters<BotCommandPublisher['publish']>[0]) {
  const publisher = await dependencies.getPublisher();
  await publisher.publish(command);
}

export function createBotController(dependencies: BotControllerDependencies) {
  const status = async (_req: Request, res: Response) => {
    try {
      const [botState, activeStrategies] = await Promise.all([
        dependencies.prisma.botState.findUnique({ where: { id: BOT_STATE_ID } }),
        dependencies.prisma.botStrategyConfig.findMany({ where: { isEnabled: true }, orderBy: { strategyName: 'asc' } }),
      ]);
      return res.json({ ok: true, data: { botState, activeStrategies: activeStrategies.map((strategy) => ({ ...strategy, configJson: redactSensitiveFields(strategy.configJson) })) } });
    } catch (error) {
      dependencies.logger.error({ err: error }, 'Failed to retrieve bot state');
      return failure(res, 'Unable to retrieve bot state');
    }
  };

  const transition = (command: 'START' | 'PAUSE' | 'STOP', nextStatus: 'RUNNING' | 'PAUSED' | 'STOPPED', auditAction: string) => async (req: Request, res: Response) => {
    try {
      const requestedBy = req.user?.id;
      if (!requestedBy) return res.status(401).json({ ok: false, error: 'Authentication required' });
      const currentConfig = await dependencies.prisma.botConfig.findUnique({ where: { userId: requestedBy } });
      if (command === 'START' && currentConfig?.isEmergencyStop) {
        return res.status(409).json({ ok: false, error: 'Emergency stop must be explicitly cleared before starting' });
      }
      const disablesLive = currentConfig?.tradingMode === 'LIVE' || currentConfig?.isLiveEnabled === true;
      await dependencies.prisma.botConfig.upsert({
        where: { userId: requestedBy },
        update: {
          status: nextStatus,
          ...(disablesLive ? { tradingMode: 'PAPER' as const, isLiveEnabled: false, liveApprovalCompleted: false, isPaperModeDefault: true } : {}),
          updatedAt: new Date(),
        },
        create: {
          userId: requestedBy,
          botName: 'main-bot',
          status: nextStatus,
          tradingMode: 'PAPER',
          isLiveEnabled: false,
          liveApprovalCompleted: false,
          isScannerEnabled: true,
          isPaperModeDefault: true,
        },
      });
      if (disablesLive) {
        await dependencies.logAuditEvent('live_mode_disabled', requestedBy, { source: `bot_${nextStatus.toLowerCase()}` });
        if (nextStatus !== 'RUNNING' && currentConfig?.isLiveEnabled) {
          await dependencies.logAuditEvent('trading_halted', requestedBy, { source: `bot_${nextStatus.toLowerCase()}` });
        }
      }
      const state = await updateState(dependencies, nextStatus, requestedBy);
      await publish(dependencies, { command, payload: { requestedBy } });
      await dependencies.logAuditEvent(auditAction, requestedBy, { botStateId: BOT_STATE_ID, status: nextStatus, command });
      return res.json({ ok: true, data: { botState: state } });
    } catch (error) {
      dependencies.logger.error({ err: error }, `Bot ${command.toLowerCase()} failed`);
      return failure(res, `Unable to ${command.toLowerCase()} bot`);
    }
  };

  const emergencyStop = async (req: Request, res: Response) => {
    try {
      const requestedBy = req.user?.id;
      if (!requestedBy) return res.status(401).json({ ok: false, error: 'Authentication required' });
      const state = await dependencies.prisma.$transaction(async (transaction) => {
        await transaction.trade.updateMany({
          where: { status: 'PENDING', mode: 'PAPER' },
          data: { status: 'FAILED', exitReason: 'EMERGENCY_STOP' },
        });
        return transaction.botState.upsert({
          where: { id: BOT_STATE_ID },
          update: { status: 'EMERGENCY_STOP', updatedBy: requestedBy },
          create: { id: BOT_STATE_ID, status: 'EMERGENCY_STOP', updatedBy: requestedBy },
        });
      });
      await publish(dependencies, { command: 'EMERGENCY_STOP', payload: { requestedBy, reason: 'API emergency stop' } });
      await dependencies.logAuditEvent('bot_emergency_stop', requestedBy, { botStateId: BOT_STATE_ID, status: 'EMERGENCY_STOP', pendingOffersCancelled: true });
      return res.json({ ok: true, data: { botState: state, pendingOffersCancelled: true } });
    } catch (error) {
      dependencies.logger.error({ err: error }, 'Bot emergency stop failed');
      return failure(res, 'Unable to execute emergency stop');
    }
  };

  const toggleStrategy = async (req: Request, res: Response) => {
    try {
      const requestedBy = req.user?.id;
      if (!requestedBy) return res.status(401).json({ ok: false, error: 'Authentication required' });
      const isEnabled = req.body?.isEnabled;
      if (typeof isEnabled !== 'boolean') return res.status(400).json({ ok: false, error: 'isEnabled must be boolean' });
      const strategyNameParam = req.params.name;
      const strategyName = Array.isArray(strategyNameParam) ? strategyNameParam[0] : strategyNameParam;
      if (!strategyName) return res.status(400).json({ ok: false, error: 'Strategy name is required' });
      const current = await dependencies.prisma.botStrategyConfig.findUnique({ where: { strategyName } });
      const configJson = current?.configJson && typeof current.configJson === 'object' && !Array.isArray(current.configJson)
        ? redactSensitiveFields(current.configJson) as Record<string, unknown>
        : {};
      const state = await dependencies.prisma.botStrategyConfig.upsert({
        where: { strategyName },
        update: { isEnabled, configJson: configJson as Prisma.InputJsonValue, updatedAt: new Date() },
        create: { strategyName, isEnabled, configJson: configJson as Prisma.InputJsonValue },
      });
      const payload: BotCommandPayload<'UPDATE_STRATEGY_CONFIG'> = {
        requestedBy,
        strategyName,
        isEnabled,
        configJson,
        maxExposure: state.maxExposure?.toNumber(),
        maxPositions: state.maxPositions ?? undefined,
      };
      await publish(dependencies, { command: 'UPDATE_STRATEGY_CONFIG', payload });
      await dependencies.logAuditEvent('bot_strategy_toggle', requestedBy, { strategyName, isEnabled });
      return res.json({ ok: true, data: { strategy: { ...state, configJson: redactSensitiveFields(state.configJson) } } });
    } catch (error) {
      dependencies.logger.error({ err: error, strategy: req.params.name }, 'Bot strategy toggle failed');
      return failure(res, 'Unable to toggle strategy');
    }
  };

  return { status, start: transition('START', 'RUNNING', 'bot_start'), pause: transition('PAUSE', 'PAUSED', 'bot_pause'), stop: transition('STOP', 'STOPPED', 'bot_stop'), emergencyStop, toggleStrategy };
}
