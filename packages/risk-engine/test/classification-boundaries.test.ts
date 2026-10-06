import { describe, expect, it } from 'vitest';

import { classifyRiskScore } from '../src/index.js';

describe('risk classification boundaries (LOW <= 30, MODERATE <= 50, HIGH <= 90, VERY_HIGH <= 100)', () => {
  const thresholds = { lowRiskMax: 30, moderateRiskMax: 50, highRiskMax: 90, veryHighRiskMax: 100 };

  it.each([
    [0, 'LOW'],
    [30, 'LOW'],
    [30.5, 'MODERATE'],
    [31, 'MODERATE'],
    [50, 'MODERATE'],
    [51, 'HIGH'],
    [53, 'HIGH'],
    [71, 'HIGH'],
    [90, 'HIGH'],
    [91, 'VERY_HIGH'],
    [100, 'VERY_HIGH'],
    [100.5, 'EXTREME'],
  ])('score %s -> %s', (score, expected) => {
    expect(classifyRiskScore(score, thresholds)).toBe(expected);
  });
});
