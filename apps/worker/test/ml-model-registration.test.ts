/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory prisma fake */
/**
 * Training registration never changes the active model: a new model is a new immutable TRAINED row without PAPER
 * approval; no user selection (MlPaperSettings) is read or written; an existing version is refused, not overwritten.
 */
import { resolveEntryAuthority } from '@soltrader/strategy-engine';
import { describe, expect, it } from 'vitest';

import { registerTrainedModel } from '../src/ml/model-registration.js';

function fakePrisma() {
  const rows = new Map<string, any>([['ML-LGBM-NL-DATASET-v3-s42', { version: 'ML-LGBM-NL-DATASET-v3-s42', status: 'SHADOW', paperApproved: true, artifactHash: 'v3hash' }]]);
  const touched: string[] = [];
  const prisma = new Proxy({}, {
    get(_target, model: string) {
      if (model !== 'mlModelVersion') {
        touched.push(model);
        return new Proxy({}, { get: () => async () => { throw new Error(`${model} must not be used`); } });
      }
      return {
        findUnique: async ({ where }: any) => rows.get(where.version) ?? null,
        create: async ({ data }: any) => {
          if (rows.has(data.version)) throw new Error('unique');
          rows.set(data.version, data);
          return data;
        },
      };
    },
  }) as any;
  return { prisma, rows, touched };
}

const metadata = (modelVersion: string) => ({ modelVersion, algorithm: 'lightgbm', readiness: 'RESEARCH_ONLY', featureVersion: 'ML-FEATURES-COMMUNITY-v1', labelVersion: 'ML-LABELS-v1', target: 'simExitNetPositive', config: {}, trainedAt: new Date().toISOString(), metrics: {} });

describe('model registration after training', () => {
  it('registers a new TRAINED, unapproved model and leaves every selection untouched', async () => {
    const { prisma, rows, touched } = fakePrisma();
    const settings = { strategyMode: 'ML', modelVersion: 'ML-LGBM-NL-DATASET-v3-s42' };
    const before = resolveEntryAuthority({ mlOnly: true, settings, model: rows.get('ML-LGBM-NL-DATASET-v3-s42'), tradingMode: 'PAPER' });
    await registerTrainedModel(prisma, { metadata: metadata('ML-LGBM-COMMUNITY-v1-s42'), datasetVersion: 'COMMUNITY-v1', artifactPath: 'ml/models/ML-LGBM-COMMUNITY-v1-s42/model.json', artifactHash: 'newhash', actor: 'cli:test', extraMetrics: {} });
    expect(rows.get('ML-LGBM-COMMUNITY-v1-s42')).toMatchObject({ status: 'TRAINED', paperApproved: false });
    expect(touched).toEqual([]);
    const after = resolveEntryAuthority({ mlOnly: true, settings, model: rows.get('ML-LGBM-NL-DATASET-v3-s42'), tradingMode: 'PAPER' });
    expect(after).toEqual(before);
    expect(rows.get('ML-LGBM-NL-DATASET-v3-s42')).toMatchObject({ status: 'SHADOW', paperApproved: true, artifactHash: 'v3hash' });
  });

  it('an existing version (e.g. the active v3 model) is refused, never overwritten', async () => {
    const { prisma, rows } = fakePrisma();
    await expect(registerTrainedModel(prisma, { metadata: metadata('ML-LGBM-NL-DATASET-v3-s42'), datasetVersion: 'NL-DATASET-v3', artifactPath: 'x', artifactHash: 'other', actor: 'cli:test', extraMetrics: {} })).rejects.toThrow(/immutable/);
    expect(rows.get('ML-LGBM-NL-DATASET-v3-s42')).toMatchObject({ artifactHash: 'v3hash', paperApproved: true });
  });
});
