/**
 * Autonomous ML (ML-FEATURES-AUTONOMOUS-v1 / AUTO-LABELS-v1 / bundle decisions / protection):
 *  - features only from data known at the decision moment; late groups excluded; missing = null, never 0;
 *  - counterfactual labels from the path, with exclusions instead of guesses;
 *  - bundle inference equals the Python trainer (parity fixture); BUY / WAIT / SKIP and HOLD / PARTIAL_SELL / SELL;
 *  - the protection layer only blocks / reduces, and forced exits never use an invented price.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildAutonomousDataset, buildAutonomousSnapshot, buildCommunityFeatureSnapshot, decideEntry, decideExit, DEFAULT_AUTONOMOUS_PROTECTION, entryProtection, exitProtection, impactPercent,
  labelEntry, labelPosition, maxNotionalForImpact, ML_AUTONOMOUS_FEATURE_SCHEMA, ML_COMMUNITY_FEATURE_SCHEMA, mlAutonomousFeatureSchemaJson, pathSamples, rawScoreOf, replayPosition, validateBundle,
  type AutonomousBundle, type LaunchSecurity, type OutcomePathState, type PathBucket,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const T = Date.parse('2026-10-22T12:00:00Z');
const security: LaunchSecurity = { sellability: 'VERIFIED', mintAuthorityRevoked: true, freezeAuthorityRevoked: true, tokenProgram: 'spl-token', extensions: [], hardBlockReasons: [], warnings: [] };
const observations = Array.from({ length: 10 }, (_, i) => ({ takenAt: T - 30_000 + i * 3_000, priceUsd: 0.00001, liquidityUsd: 30_000, buyCount: 3 + i, sellCount: 1, volumeUsd: 100 + i * 40, buyVolumeUsd: 80, sellVolumeUsd: 20, uniqueBuyers: 2 + i, uniqueSellers: 1 }));
const base = buildCommunityFeatureSnapshot({
  snapshotAt: T, source: 'PUMP_FUN', detectedAt: T - 30_000, createdAt: T - 31_000, firstTradeAt: T - 29_000,
  state: { mint: 'M', detectedAt: T - 30_000, createdAt: T - 31_000, observations, largestBuyerShare: 0.1, buysPerBuyer: 1.2, creatorSoldRatio: 0, largestHolderSupplyShare: 0.04, priceImpactPercent: 1, observedSellers: 3 },
  security, securityObservedAt: T - 5_000, riskScore: 40, riskObservedAt: T, social: null, referenceImpactPct: 1, community: null,
});
const samples = [{ t: T - 120_000, price: 1, liquidityUsd: 10_000, tradeCount: 0 }, { t: T - 60_000, price: 1.1, liquidityUsd: 11_000, tradeCount: 30 }, { t: T - 30_000, price: 1.2, liquidityUsd: 12_000, tradeCount: 50 }, { t: T, price: 1.32, liquidityUsd: 12_000, tradeCount: 80 }, { t: T + 5_000, price: 9, liquidityUsd: 1, tradeCount: 999 }];

describe('ML-FEATURES-AUTONOMOUS-v1 snapshot', () => {
  it('schema = community schema + the autonomous groups (exported JSON identical)', () => {
    expect(ML_AUTONOMOUS_FEATURE_SCHEMA.slice(0, ML_COMMUNITY_FEATURE_SCHEMA.length)).toEqual(ML_COMMUNITY_FEATURE_SCHEMA);
    expect(JSON.parse(readFileSync(path.join(here, '..', '..', '..', 'ml', 'schema', 'features-autonomous-v1.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(mlAutonomousFeatureSchemaJson())));
  });

  it('dynamics use only samples known at the moment (the later 9.0 price is never seen)', () => {
    const snapshot = buildAutonomousSnapshot({ kind: 'ENTRY', at: T, base, samples, quote: { price: 1.32, liquidityUsd: 12_000, at: T } });
    expect(snapshot.features.ret1mPct).toBeCloseTo(20, 3);
    expect(snapshot.features.ret30sPct).toBeCloseTo(10, 3);
    expect(snapshot.features.tradeRate1m).toBe(50);
    expect(snapshot.features.liquidityChange1mPct).toBeCloseTo((12_000 / 11_000 - 1) * 100, 3);
    expect(snapshot.referencePriceUsd).toBe(1.32);
    expect(snapshot.validForTraining).toBe(true);
    expect(snapshot.features.estimatedEntryImpactPct).toBeCloseTo(impactPercent(20, 12_000), 4);
  });

  it('missing inputs are null (never 0); POSITION features null on ENTRY rows', () => {
    const snapshot = buildAutonomousSnapshot({ kind: 'ENTRY', at: T, base, samples: [], quote: null });
    for (const name of ['ret1mPct', 'ret5mPct', 'volatility1mPct', 'tradeRate1m', 'liquidityNowUsd', 'roundTripCostPct', 'marketRegime', 'newBuyerShare1m', 'unrealizedNetPct', 'holdSeconds', 'portfolioExposurePct', 'openPositions']) expect(snapshot.features[name], name).toBeNull();
    expect(snapshot.features.decisionKind).toBe('ENTRY');
  });

  it('late regime / portfolio / quote data is excluded and audited; future base is invalid', () => {
    const late = buildAutonomousSnapshot({ kind: 'ENTRY', at: T, base, samples, quote: { price: 2, liquidityUsd: 1, at: T + 1 }, regime: { at: T + 1, launchRate10m: 5, medianLaunchReturnPct: 50, positiveLaunchShare: 1 }, portfolio: { at: T + 1, exposurePct: 1, openPositions: 1, dayPnlPct: 1 } });
    expect(late.lateDataExcluded).toEqual(expect.arrayContaining(['EXECUTION', 'REGIME', 'PORTFOLIO']));
    expect(late.features.marketRegime).toBeNull();
    expect(late.features.openPositions).toBeNull();
    expect(late.referencePriceUsd).toBe(1.32);
    expect(late.observedAt.REGIME).toBe(T + 1);
    const future = buildAutonomousSnapshot({ kind: 'ENTRY', at: T - 1, base, samples, quote: null });
    expect(future.validForTraining).toBe(false);
    expect(future.invalidReasons).toContain('FUTURE_DATA_BASE');
  });

  it('POSITION: unrealized net after exit costs, MFE / MAE, hold time', () => {
    const position = { openedAt: T - 60_000, entryFillPrice: 1.0, entryMarketPrice: 0.99, entryNotionalUsd: 20, entryImpactPct: 1, highestPrice: 1.5, lowestPrice: 0.9, quantity: 20, partiallySold: false };
    const snapshot = buildAutonomousSnapshot({ kind: 'POSITION', at: T, base, samples, quote: { price: 1.32, liquidityUsd: 12_000, at: T }, position });
    const exitImpact = impactPercent(20 * 1.32, 12_000);
    expect(snapshot.features.unrealizedNetPct).toBeCloseTo(((20 * 1.32 * (1 - exitImpact / 100) * 0.997) / (20 * 1.003) - 1) * 100, 3);
    expect(snapshot.features).toMatchObject({ mfePct: 50, holdSeconds: 60, positionOpen: true, decisionKind: 'POSITION' });
    expect(snapshot.features.maePct).toBeCloseTo(-10, 6);
    expect(buildAutonomousSnapshot({ kind: 'POSITION', at: T, base, samples, quote: null }).invalidReasons).toContain('POSITION_STATE_MISSING');
  });
});

const path0 = (buckets: PathBucket[], extra: Partial<OutcomePathState> = {}): OutcomePathState => ({ startAt: T, entryPrice: 1, entryLiquidity: 20_000, buckets, gaps: [], endedAt: T + 3_600_001, endReason: 'HORIZON_REACHED', creatorSellAt: null, ...extra });

describe('AUTO-LABELS-v1', () => {
  // 15 s buckets after 10 min: offset 600 000 bucket holds the 10 min price.
  const rising: PathBucket[] = [[1_000, 1.05, 0.95, 1.0, 3, 20_000], [300_000, 1.3, 1.1, 1.2, 5, 22_000], [600_000, 1.6, 1.4, 1.5, 4, 25_000], [720_000, 1.6, 1.5, 1.55, 2, 25_000]];
  it('entry label: net of buying now and selling at +10 min after fees and impact; downside from the lows', () => {
    const label = labelEntry(path0(rising), T);
    expect(label.status).toBe('LABELLED');
    const fill = 1 * (1 + impactPercent(20, 20_000) / 100);
    const quantity = 20 / fill;
    const expected = ((quantity * 1.5 * (1 - impactPercent(quantity * 1.5, 25_000) / 100) * 0.997) / (20 * 1.003) - 1) * 100;
    expect(label.netReturnPct!).toBeCloseTo(expected, 6);
    expect(label.netReturnPct!).toBeLessThan(label.grossReturnPct!);
    expect(label.downsideNetPct!).toBeLessThan(0);
    expect(label.horizonResolutionMs).toBe(15_000);
  });

  it('exclusions instead of guesses: gap, early end, beyond the path, before the path', () => {
    expect(labelEntry(path0(rising, { gaps: [[T + 100_000, T + 110_000]] }), T).exclusion).toBe('DATA_GAP');
    expect(labelEntry(path0(rising, { endedAt: T + 200_000, endReason: 'MIGRATED' }), T).exclusion).toBe('OBSERVATION_ENDED');
    expect(labelEntry(path0(rising), T + 3_300_000).exclusion).toBe('HORIZON_BEYOND_PATH');
    expect(labelEntry(path0(rising), T - 1).exclusion).toBe('BEFORE_PATH_START');
    expect(labelEntry(null, T).exclusion).toBe('NO_PATH');
  });

  it('position label = sell later minus sell now; replayed state uses only buckets that ended by t', () => {
    const position = replayPosition(path0(rising), T + 310_000)!;
    expect(position.highestPrice).toBe(1.3);
    expect(replayPosition(path0(rising), T + 300_000)!.highestPrice).toBe(1.05);
    const label = labelPosition(path0(rising), T + 315_000, position);
    expect(label.status).toBe('LABELLED');
    expect(label.holdAdvantagePct!).toBeCloseTo(label.sellLaterNetPct! - label.sellNowNetPct!, 9);
    expect(pathSamples(path0(rising), T + 310_000).map((sample) => sample.price)).toEqual([1, 1, 1.2]);
  });

  it('dataset: replay entry + position rows grouped by mint, exclusions counted, no future rows', () => {
    const snapshot = { ...base, id: 'snap1' };
    const built = buildAutonomousDataset({ version: 'TEST', replay: [{ snapshot, mint: 'MINT1', path: path0(rising) }], live: [] });
    expect(built.rows.length).toBeGreaterThan(1);
    expect(new Set(built.rows.map((row) => row.groupId))).toEqual(new Set(['MINT1']));
    expect(built.rows.every((row) => row.labelEnd > row.at)).toBe(true);
    expect((built.manifest.coverage as Record<string, unknown>).excluded).toBeTruthy();
    expect(built.csv.split('\n')[0]).toContain('entry_net_pct');
    // A stored path without data (e.g. a fixture row) is excluded with its own reason, never treated as flat prices.
    const broken = buildAutonomousDataset({ version: 'TEST', replay: [{ snapshot, mint: 'MINT2', path: {} as OutcomePathState }], live: [] });
    expect(broken.rows).toEqual([]);
    expect((broken.manifest.coverage as Record<string, unknown>).excluded).toEqual({ REPLAY_PATH_INVALID: 1 });
  });
});

const fixture = JSON.parse(readFileSync(path.join(here, 'fixtures', 'autonomous-parity.json'), 'utf8')) as { bundle: AutonomousBundle; rows: Array<Record<string, number> & { features: Record<string, number | string | null> }> };

describe('Autonomous bundle', () => {
  const bundle = validateBundle(fixture.bundle);
  it('TypeScript inference equals the Python trainer for every component (parity)', () => {
    for (const row of fixture.rows) for (const name of ['entryReturn', 'entryDownside', 'entryProfit', 'exitAdvantage', 'exitHold'] as const) expect(rawScoreOf(bundle.components[name], row.features)).toBeCloseTo(row[name], 6);
  });

  it('validation: foreign feature version / missing component / unsafe sizing are rejected', () => {
    expect(() => validateBundle({ ...fixture.bundle, featureVersion: 'ML-FEATURES-v1' })).toThrow();
    expect(() => validateBundle({ ...fixture.bundle, components: { ...fixture.bundle.components, exitHold: undefined } })).toThrow(/exitHold/);
    expect(() => validateBundle({ ...fixture.bundle, sizing: { ...fixture.bundle.sizing, maxFractionPct: 80 } })).toThrow();
    expect(() => validateBundle({ ...fixture.bundle, components: { ...fixture.bundle.components, entryReturn: { ...fixture.bundle.components.entryReturn, objective: 'binary' } } })).toThrow();
  });

  const policyBundle = (entry: Partial<AutonomousBundle['policy']['entry']>, exit: Partial<AutonomousBundle['policy']['exit']> = {}) => ({ ...bundle, policy: { entry: { ...bundle.policy.entry, ...entry }, exit: { ...bundle.policy.exit, ...exit } } });
  const features = fixture.rows[0].features;

  it('BUY with a proposed size, WAIT and SKIP are model decisions (no DEFAULT thresholds)', () => {
    const buy = decideEntry(policyBundle({ minProbability: 0, minExpectedNetPct: -1e9, minDownsideNetPct: -1e9 }), features, { equityUsd: 1_000, liquidityUsd: 50_000 });
    if (buy.outputs!.expectedNetPct > 0) {
      expect(buy.action).toBe('BUY');
      expect(buy.suggestedSizeUsd!).toBeGreaterThan(0);
      expect(buy.suggestedSizeUsd!).toBeLessThanOrEqual(1_000 * bundle.sizing.maxFractionPct / 100);
    } else expect(buy.action).not.toBe('BUY');
    const skip = decideEntry(policyBundle({ minProbability: 1.01, waitMinProbability: 1.01 }), features, { equityUsd: 1_000, liquidityUsd: 50_000 });
    expect(skip.action).toBe('SKIP');
    expect(skip.reasons).toContain('PROBABILITY_BELOW_POLICY');
    const wait = decideEntry(policyBundle({ minProbability: 1.01, waitMinProbability: 0 }), features, { equityUsd: 1_000, liquidityUsd: 50_000 });
    expect(wait.action).toBe(wait.outputs!.expectedNetPct > 0 ? 'WAIT' : 'SKIP');
  });

  it('HOLD / PARTIAL_SELL / SELL from the exit components and the bundle policy', () => {
    const out = decideExit(bundle, features, { partiallySold: false }).outputs!;
    expect(decideExit(policyBundle({}, { sellBelowAdvantagePct: out.holdAdvantagePct + 1, minHoldProbability: 0 }), features, { partiallySold: false }).action).toBe('SELL');
    expect(decideExit(policyBundle({}, { sellBelowAdvantagePct: -1e9, partialBelowAdvantagePct: out.holdAdvantagePct + 1, minHoldProbability: 0 }), features, { partiallySold: false })).toMatchObject({ action: 'PARTIAL_SELL', sellFraction: 0.5 });
    expect(decideExit(policyBundle({}, { sellBelowAdvantagePct: -1e9, partialBelowAdvantagePct: out.holdAdvantagePct + 1, minHoldProbability: 0 }), features, { partiallySold: true }).action).toBe('HOLD');
    expect(decideExit(policyBundle({}, { sellBelowAdvantagePct: -1e9, partialBelowAdvantagePct: -1e9, minHoldProbability: 0 }), features, { partiallySold: false }).action).toBe('HOLD');
  });

  it('a broken component is an ERROR (never a BUY)', () => {
    const broken = { ...bundle, components: { ...bundle.components, entryReturn: { ...bundle.components.entryReturn, lightgbm: { trees: [{ tree_structure: { leaf_value: Number.NaN } }] } } } } as AutonomousBundle;
    expect(decideEntry(broken, features, { equityUsd: 1_000, liquidityUsd: 50_000 }).action).toBe('ERROR');
  });
});

describe('protection layer', () => {
  const entry = (extra: Partial<Parameters<typeof entryProtection>[0]> = {}) => entryProtection({
    tradingMode: 'PAPER', liveEnabled: false, emergencyStop: false, quoteAgeMs: 1_000, liquidityUsd: 50_000, requestedSizeUsd: 40, equityUsd: 1_000, cashUsd: 1_000, exposureUsd: 0,
    dayPnlUsd: 0, dayStartEquityUsd: 1_000, openPositions: 0, alreadyHolding: false, tokenBlockers: [], ...extra,
  });
  it('only reduces the size (position cap, exposure room, impact limit)', () => {
    expect(entry()).toMatchObject({ allowed: true, sizeUsd: 40 });
    expect(entry({ requestedSizeUsd: 500 }).sizeUsd).toBe(1_000 * DEFAULT_AUTONOMOUS_PROTECTION.maxPositionPctOfEquity / 100);
    expect(entry({ requestedSizeUsd: 500, exposureUsd: 240 }).sizeUsd).toBe(10);
    expect(entry({ requestedSizeUsd: 500, liquidityUsd: 1_000 }).sizeUsd).toBeLessThanOrEqual(maxNotionalForImpact(1_000, DEFAULT_AUTONOMOUS_PROTECTION.maxImpactPct));
  });
  it('blocks: LIVE / non-PAPER, emergency stop, stale or missing quote, token fraud blockers, daily loss, max positions, duplicate token', () => {
    expect(entry({ liveEnabled: true }).blockers).toContain('PAPER_MODE_REQUIRED');
    expect(entry({ tradingMode: 'LIVE' }).blockers).toContain('PAPER_MODE_REQUIRED');
    expect(entry({ emergencyStop: true }).blockers).toContain('EMERGENCY_STOP');
    expect(entry({ quoteAgeMs: 60_000 }).blockers).toContain('MARKET_DATA_STALE');
    expect(entry({ quoteAgeMs: null }).blockers).toContain('MARKET_DATA_UNAVAILABLE');
    expect(entry({ tokenBlockers: ['SELLABILITY_FAILED'] }).blockers).toContain('SELLABILITY_FAILED');
    expect(entry({ dayPnlUsd: -90 }).blockers).toContain('DAILY_LOSS_LIMIT');
    expect(entry({ openPositions: 4 }).blockers).toContain('MAX_OPEN_POSITIONS');
    expect(entry({ alreadyHolding: true }).blockers).toContain('ALREADY_HOLDING_TOKEN');
    expect(entry({ emergencyStop: true }).sizeUsd).toBe(0);
  });
  it('fail-safe exits act without the model; never at an invented price', () => {
    const base = { netIfSoldPct: -5, liquidityUsd: 20_000, entryLiquidityUsd: 20_000, holdMs: 60_000, quoteAgeMs: 1_000, sellRouteAvailable: true };
    expect(exitProtection(base).reason).toBeNull();
    expect(exitProtection({ ...base, netIfSoldPct: -40 })).toEqual({ reason: 'HARD_MAX_LOSS', waitForQuote: false });
    expect(exitProtection({ ...base, liquidityUsd: 5_000 }).reason).toBe('LIQUIDITY_COLLAPSE');
    expect(exitProtection({ ...base, holdMs: 121 * 60_000 }).reason).toBe('TECHNICAL_MAX_HOLD');
    expect(exitProtection({ ...base, sellRouteAvailable: false, quoteAgeMs: null })).toEqual({ reason: 'SELL_ROUTE_LOST', waitForQuote: true });
    expect(exitProtection({ ...base, netIfSoldPct: -40, quoteAgeMs: 120_000 })).toEqual({ reason: 'HARD_MAX_LOSS', waitForQuote: true });
  });
});
