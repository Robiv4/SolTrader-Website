import { describe, expect, it } from 'vitest';

import { effectiveDailyLossLimit } from '../src/paper-accounting.js';

describe('daily loss limit', () => {
  it('uses the USDC amount instead of the percent when both are set', () => {
    // Raising the USDC limit must take effect even though 5% of 950 would be stricter.
    expect(effectiveDailyLossLimit(950, 5, 10_000)).toEqual({ limit: 10_000, source: 'ABSOLUTE' });
  });

  it('falls back to the percent of equity when no USDC amount is set', () => {
    expect(effectiveDailyLossLimit(950, 5, null)).toEqual({ limit: 47.5, source: 'PERCENT' });
    expect(effectiveDailyLossLimit(950, 5, 0)).toEqual({ limit: 47.5, source: 'PERCENT' });
  });

  it('treats zero or missing values as disabled instead of blocking every entry', () => {
    expect(effectiveDailyLossLimit(950, 0, null)).toEqual({ limit: null, source: null });
    expect(effectiveDailyLossLimit(950, null, undefined)).toEqual({ limit: null, source: null });
  });
});
