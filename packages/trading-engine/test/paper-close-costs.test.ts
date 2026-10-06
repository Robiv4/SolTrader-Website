/* eslint-disable @typescript-eslint/no-explicit-any -- minimal transaction mock */
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { closePaperPosition } from '../src/paper-accounting.js';

/**
 * Known inputs: market entry 1.00, 1% entry slippage -> fill 1.01, notional 101 USDC -> quantity 100,
 * entry fee 0.303. Exit at market 1.20 with 1% exit slippage -> fill 1.188, exit fee 0.3564.
 */
function fixture() {
  const position: any = {
    id: 'p1', userId: 'u1', tokenId: 't1', signalId: null, side: 'BUY', status: 'OPEN', mode: 'PAPER',
    quantity: new Prisma.Decimal(100), avgEntryPrice: new Prisma.Decimal(1.01), currentPrice: new Prisma.Decimal(1.2),
    entryMarketPrice: new Prisma.Decimal(1), highestPrice: new Prisma.Decimal(1.25), lowestPrice: new Prisma.Decimal(0.98),
    stopLossPrice: new Prisma.Decimal(0.808), takeProfitPrice: new Prisma.Decimal(1.2625), trailingStopPercent: new Prisma.Decimal(0.08),
    trailingActivationPercent: new Prisma.Decimal(0.15), trailingActive: true, trailingActivatedAt: new Date('2026-09-28T10:01:00Z'),
    trailingActivationPrice: new Prisma.Decimal(1.17), trailingTriggerPrice: new Prisma.Decimal(1.15), breakEvenAppliedAt: null,
    openedAt: new Date('2026-09-28T10:00:00Z'), token: { address: 'TOKEN', symbol: 'TKN' },
  };
  const openTrade: any = { id: 'tr1', fees: new Prisma.Decimal(0.303), slippage: new Prisma.Decimal(1) };
  const account: any = { id: 'a1', cashBalance: new Prisma.Decimal(898.697), realizedPnl: new Prisma.Decimal(0), totalFees: new Prisma.Decimal(0.303) };
  const writes: any = {};
  const tx: any = {
    position: {
      updateMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => position,
      update: async ({ data }: any) => { writes.position = data; return position; },
      findMany: async () => [],
    },
    trade: {
      findFirst: async () => openTrade,
      update: async ({ data }: any) => { writes.trade = data; return { id: 'tr1', ...data }; },
    },
    paperAccount: {
      updateMany: async ({ data }: any) => { writes.account = data; account.cashBalance = account.cashBalance.plus(data.cashBalance.increment); return { count: 1 }; },
      findUnique: async () => account,
      update: async ({ data }: any) => ({ ...account, ...data }),
    },
  };
  return { tx, writes, account };
}

describe('PAPER close: costs are counted exactly once', () => {
  it('books gross, fees, slippage and net P&L consistently', async () => {
    const { tx, writes, account } = fixture();
    const result = await closePaperPosition(tx, { positionId: 'p1', userId: 'u1', exitPrice: 1.2, exitSlippagePercent: 1, exitReason: 'TRAILING_STOP', closedAt: new Date('2026-09-28T10:05:00Z') });
    expect(result).not.toBeNull();
    // Sell fill is BELOW the market price.
    expect(result!.exitMarketPrice).toBeCloseTo(1.2, 12);
    expect(result!.exitPrice).toBeCloseTo(1.188, 12);
    expect(result!.exitSlippage).toBeCloseTo(1.2, 10);
    // gross = (exitFill - entryFill) * qty = (1.188 - 1.01) * 100
    expect(result!.grossPnl).toBeCloseTo(17.8, 10);
    expect(result!.exitFee).toBeCloseTo(0.3564, 10);
    // net = gross - entry fee - exit fee; slippage is NOT subtracted again.
    expect(result!.netPnl).toBeCloseTo(17.8 - 0.303 - 0.3564, 10);
    expect(Number(writes.trade.fees)).toBeCloseTo(0.6594, 10);
    expect(Number(writes.trade.slippage)).toBeCloseTo(2.2, 10);
    expect(Number(writes.trade.exitSlippage)).toBeCloseTo(1.2, 10);
    expect(Number(writes.trade.exitMarketPrice)).toBeCloseTo(1.2, 12);
    // Cash returned = exit notional - exit fee = 118.8 - 0.3564.
    expect(Number(writes.account.cashBalance.increment)).toBeCloseTo(118.4436, 10);
    // Round trip: 1000 start -> 898.697 after entry -> +118.4436 = 1000 + net.
    expect(Number(account.cashBalance)).toBeCloseTo(1_000 + result!.netPnl, 10);
    expect(writes.trade.exitDiagnostics).toMatchObject({ exitReason: 'TRAILING_STOP', trailingActive: true, trailingTriggerPrice: 1.15, highestPrice: 1.25, fillPolicy: 'SNAPSHOT_PRICE_MINUS_MODELLED_SLIPPAGE' });
  });

  it('keeps the legacy behaviour (fill at the market price) when no exit slippage is given', async () => {
    const { tx } = fixture();
    const result = await closePaperPosition(tx, { positionId: 'p1', userId: 'u1', exitPrice: 1.2, exitReason: 'manual-close' });
    expect(result!.exitPrice).toBeCloseTo(1.2, 12);
    expect(result!.exitSlippage).toBe(0);
  });
});
