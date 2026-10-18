/* eslint-disable @typescript-eslint/no-explicit-any -- spy social service */
/**
 * Research collection is independent of the user's social settings: every evaluated launch is tracked for Telegram /
 * metadata collection, while the user's decision, the DEFAULT strategy and the ML-FEATURES-v1 inputs stay exactly as
 * before (social OFF -> no social snapshot used anywhere on the trading path).
 */
import { describe, expect, it } from 'vitest';

import { runScenario } from './helpers/ml-scenario.js';

function spySocial() {
  const tracked: Array<{ mint: string; stage: number }> = [];
  let assessCalls = 0;
  return {
    tracked,
    assessCalls: () => assessCalls,
    factory: () => ({
      track: (input: { mint: string; stage: number }) => tracked.push({ mint: input.mint, stage: input.stage }),
      assess: () => {
        assessCalls += 1;
        return null;
      },
      latest: () => null,
    }) as any,
  };
}

const decisions = (run: Awaited<ReturnType<typeof runScenario>>) => run.record.decisions.map((row: any) => [row.decision, row.status, JSON.stringify(row.reasons)]);

describe('social research tracking', () => {
  it('social OFF for the user: the launch is still tracked for collection, but no social result is read for trading', async () => {
    const spy = spySocial();
    const run = await runScenario({ mode: 'DEFAULT', engine: 'none', config: { socialIntelligenceEnabled: false } }, { social: spy.factory });
    expect(spy.tracked.length).toBeGreaterThan(0);
    expect(new Set(spy.tracked.map((item) => item.mint)).size).toBe(1);
    expect(spy.assessCalls()).toBe(0);
    const baseline = await runScenario({ mode: 'DEFAULT', engine: 'none', config: { socialIntelligenceEnabled: false } });
    expect(decisions(run)).toEqual(decisions(baseline));
    expect(run.record.signals.length).toBe(baseline.record.signals.length);
  }, 60_000);

  it('ML PAPER with social OFF: ML-FEATURES-v1 decision features identical with and without the research collection', async () => {
    const spy = spySocial();
    const withCollection = await runScenario({ mode: 'ML', probability: 0.95, config: { socialIntelligenceEnabled: false } }, { social: spy.factory });
    const without = await runScenario({ mode: 'ML', probability: 0.95, config: { socialIntelligenceEnabled: false } });
    expect(spy.tracked.length).toBeGreaterThan(0);
    expect(withCollection.paperDecisions[0].featureVersion).toBe('ML-FEATURES-v1');
    expect(withCollection.paperDecisions[0].features).toEqual(without.paperDecisions[0].features);
    expect(withCollection.paperDecisions[0].mlDecision).toBe(without.paperDecisions[0].mlDecision);
    expect(withCollection.record.signals.length).toBe(without.record.signals.length);
  }, 60_000);

  it('social ON: unchanged behaviour (tracked and assessed for the user)', async () => {
    const spy = spySocial();
    await runScenario({ mode: 'DEFAULT', engine: 'none', config: { socialIntelligenceEnabled: true } }, { social: spy.factory });
    expect(spy.tracked.length).toBeGreaterThan(0);
    expect(spy.assessCalls()).toBeGreaterThan(0);
  }, 60_000);
});
