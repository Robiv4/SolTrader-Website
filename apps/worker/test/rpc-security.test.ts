/**
 * Security UNKNOWN must never become SAFE (tests 68 / 69 / 35): RPC failure -> UNKNOWN -> WATCH / no automatic entry.
 */
import { RPC_PRIORITY, RpcAllProvidersFailedError, SolanaRpcManager, type RpcTransport } from '@soltrader/blockchain';
import { assessRisk, DEFAULT_RISK_THRESHOLDS } from '@soltrader/risk-engine';
import { DEFAULT_NEW_LAUNCH_SETTINGS, evaluateNewLaunch, type LaunchSecurity } from '@soltrader/strategy-engine';
import { buildTokenCandidate } from '@soltrader/token-discovery';
import { describe, expect, it } from 'vitest';

const MINT = 'MintSec1111111111111111111111111111111111';
const snapshot = {
  metadata: { address: MINT, symbol: 'SEC', name: 'Sec', tokenAgeSeconds: 3_600, poolAgeSeconds: 3_600 },
  priceUsd: 0.01, liquidityUsd: 80_000, volume24h: 200_000, transactionCount: 2_000, priceChange1h: 5, priceChange24h: 10, timestamp: new Date(),
} as never;

function manager(behaviour: (method: string) => { status: number; body: unknown }) {
  const transport: RpcTransport = async ({ body }) => {
    const { method } = JSON.parse(body) as { method: string };
    const reply = behaviour(method);
    return { status: reply.status, headers: { get: () => null }, text: async () => JSON.stringify(reply.body) };
  };
  return new SolanaRpcManager({ providers: [{ role: 'primary', url: 'https://p.test' }, { role: 'fallback', url: 'https://f.test' }], transport, batchingEnabled: false });
}
const securityRead = { caller: 'Test', priority: RPC_PRIORITY.SECURITY, batchable: false } as const;
const mintAccount = { context: { slot: 1 }, value: { data: { program: 'spl-token', parsed: { info: { decimals: 6, supply: '1000000000', mintAuthority: null, freezeAuthority: null } } } } };

describe('RPC security data: UNKNOWN never becomes SAFE', () => {
  it('68. all providers fail -> authorities UNKNOWN, no ACCEPT (WATCH + infrastructure block)', async () => {
    const rpc = manager(() => ({ status: 503, body: 'down' }));
    await expect(rpc.getMintAccount(MINT, securityRead)).rejects.toBeInstanceOf(RpcAllProvidersFailedError);
    await expect(rpc.getTokenLargestAccounts(MINT, securityRead, 10)).rejects.toBeInstanceOf(RpcAllProvidersFailedError);

    const candidate = buildTokenCandidate({ snapshot, authorityStatusKnown: false, holderDataAvailable: false });
    // Even with otherwise excellent market data and an EXPLORATORY-friendly risk score, no automatic entry.
    const assessment = assessRisk({ ...candidate, holderConcentrationPercent: 10, topHolderConcentrationPercent: 5, liquidityConcentrationPercent: 10 }, { thresholds: { ...DEFAULT_RISK_THRESHOLDS, lowRiskMax: 100 } });
    expect(assessment.decision).toBe('WATCH');
    expect(assessment.dataQualityBlockReasons).toEqual(['RPC_SECURITY_DATA_UNAVAILABLE']);
    expect(assessment.warnings).toContain('AUTHORITY_STATUS_UNKNOWN');
    expect(assessment.warnings).not.toContain('MINT_AUTHORITY_ACTIVE');
    // The conservative numeric values stay (an unknown authority is never scored as revoked).
    expect(candidate.authority).toMatchObject({ mintAuthorityRevoked: false, freezeAuthorityRevoked: false });
    expect(assessment.factors.mintAuthorityRisk).toBe(100);
  });

  it('69. partial: mint info succeeds, holders fail -> mint data kept, holders UNKNOWN', async () => {
    const rpc = manager((method) => (method === 'getTokenLargestAccounts'
      ? { status: 429, body: { jsonrpc: '2.0', error: { code: 429, message: 'Too many requests for a specific RPC call' } } }
      : { status: 200, body: { jsonrpc: '2.0', result: mintAccount } }));
    const mintInfo = await rpc.getMintAccount(MINT, securityRead);
    expect(mintInfo).toMatchObject({ mintAuthority: null, freezeAuthority: null });
    await expect(rpc.getTokenLargestAccounts(MINT, securityRead, 10)).rejects.toThrow();
    const candidate = buildTokenCandidate({ snapshot, mintInfo: mintInfo as never, authorityStatusKnown: true, holderDataAvailable: false });
    const assessment = assessRisk(candidate, { thresholds: DEFAULT_RISK_THRESHOLDS });
    expect(candidate.authority).toMatchObject({ mintAuthorityRevoked: true, freezeAuthorityRevoked: true });
    expect(assessment.warnings).toContain('HOLDER_DATA_UNAVAILABLE');
    expect(assessment.warnings).not.toContain('HIGH_HOLDER_CONCENTRATION');
    expect(assessment.dataQualityBlockReasons).toEqual([]);
  });

  it('35. NewLaunch: authorities UNKNOWN after an RPC outage -> WATCH with RPC_SECURITY_DATA_UNAVAILABLE (never BUY)', () => {
    const unknown: LaunchSecurity = { sellability: 'VERIFIED', mintAuthorityRevoked: null, freezeAuthorityRevoked: null, tokenProgram: null, extensions: null, hardBlockReasons: [], warnings: [], rpcUnavailable: true };
    const state = {
      mint: MINT, detectedAt: Date.now() - 20_000, createdAt: Date.now() - 25_000, largestBuyerShare: 0.1, buysPerBuyer: 1.2, creatorSoldRatio: 0, largestHolderSupplyShare: 0.04, priceImpactPercent: 1, observedSellers: 3,
      observations: Array.from({ length: 12 }, (_, index) => ({ takenAt: Date.now() - (11 - index) * 2_000, priceUsd: 0.00001 * (1 + index / 50), liquidityUsd: 30_000 + index * 300, buyCount: 5 + index * 4, sellCount: 1 + index, volumeUsd: 500 + index * 500, buyVolumeUsd: 400 + index * 450, sellVolumeUsd: 100 + index * 50, uniqueBuyers: 3 + index * 3, uniqueSellers: 1 + Math.floor(index / 3) })),
    };
    const result = evaluateNewLaunch(state, unknown, { riskScore: 40, classification: 'MODERATE', hardBlockReasons: [] }, { ...DEFAULT_NEW_LAUNCH_SETTINGS, enabled: true }, Date.now());
    expect(result.decision).not.toBe('BUY');
    expect(result.reasons).toContain('RPC_SECURITY_DATA_UNAVAILABLE');
  });

  it('a mint that does not exist yet is "not found" (retry later), not an RPC outage', async () => {
    const rpc = manager(() => ({ status: 200, body: { jsonrpc: '2.0', result: { context: { slot: 1 }, value: null } } }));
    expect(await rpc.getMintAccount(MINT, { caller: 'Test', priority: RPC_PRIORITY.SECURITY, batchable: false })).toBeNull();
    expect(rpc.totals.securityDataUnavailable).toBe(0);
  });
});
