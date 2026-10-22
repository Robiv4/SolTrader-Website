/**
 * ML-only strategy contract: operating states, single authorised model, no DEFAULT fallback, no LIVE, training never
 * changes the authority; the input schemas of the v1 (v3 model) and Community models are unchanged.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  authorizeEntry, isSupportedFeatureVersion, ML_COMMUNITY_FEATURE_SCHEMA, ML_COMMUNITY_FEATURE_VERSION, ML_FEATURE_SCHEMA, ML_FEATURE_VERSION, mlCommunityFeatureSchemaJson, mlFeatureSchemaJson, resolveEntryAuthority, selectableStrategies,
  type StrategySelectionInput,
} from '../src/index.js';

const approved = { version: 'ML-LGBM-NL-DATASET-v3-s42', paperApproved: true, status: 'SHADOW', featureVersion: ML_FEATURE_VERSION };
const base = (extra: Partial<StrategySelectionInput> = {}): StrategySelectionInput => ({
  mlOnly: true, settings: { strategyMode: 'ML', modelVersion: approved.version }, model: approved, supportedFeatureVersion: isSupportedFeatureVersion, tradingMode: 'PAPER', ...extra,
});

describe('operating states', () => {
  it('no trading model: DATA_COLLECTION (or MODEL_TRAINING while training), no entries, collection running', () => {
    for (const settings of [null, { strategyMode: 'ML', modelVersion: null }, { strategyMode: 'DEFAULT', modelVersion: null }]) {
      const authority = resolveEntryAuthority(base({ settings, model: null }));
      expect(authority).toMatchObject({ state: 'DATA_COLLECTION', mayOpenEntries: false, entryStrategy: null, authorizedModelVersion: null, reasons: ['NO_TRADING_MODEL_SELECTED'] });
      expect(authority.components.dataCollection).toBe('RUNNING');
    }
    expect(resolveEntryAuthority(base({ settings: null, model: null, trainingInProgress: true }))).toMatchObject({ state: 'MODEL_TRAINING', mayOpenEntries: false, components: { training: 'RUNNING' } });
  });

  it('selected approved model: ML_PAPER_ACTIVE, only that model is authorised', () => {
    expect(resolveEntryAuthority(base())).toMatchObject({ state: 'ML_PAPER_ACTIVE', mayOpenEntries: true, entryStrategy: 'ML', authorizedModelVersion: approved.version });
  });

  it('a training run never changes who may trade', () => {
    expect(resolveEntryAuthority(base({ trainingInProgress: true }))).toMatchObject({ state: 'ML_PAPER_ACTIVE', authorizedModelVersion: approved.version, components: { training: 'RUNNING', trading: 'ACTIVE' } });
  });

  it('unusable model: MODEL_UNAVAILABLE, never a DEFAULT fallback', () => {
    const cases: Array<[StrategySelectionInput['model'], string]> = [
      [null, 'MODEL_NOT_FOUND'], [{ ...approved, paperApproved: false }, 'MODEL_NOT_PAPER_APPROVED'], [{ ...approved, status: 'RETIRED' }, 'MODEL_RETIRED'],
      [{ ...approved, featureVersion: 'ML-FEATURES-v999' }, 'MODEL_FEATURE_VERSION_UNSUPPORTED'], [{ ...approved, version: 'OTHER' }, 'MODEL_NOT_FOUND'],
    ];
    for (const [model, reason] of cases) {
      const authority = resolveEntryAuthority(base({ model }));
      expect(authority).toMatchObject({ state: 'MODEL_UNAVAILABLE', mayOpenEntries: false, entryStrategy: null });
      expect(authority.reasons).toContain(reason);
    }
  });

  it('TRADING_PAUSED: user pause, emergency stop, unreadable selection, LIVE / non-PAPER mode', () => {
    expect(resolveEntryAuthority(base({ settings: { strategyMode: 'ML', modelVersion: approved.version, tradingPaused: true } })).reasons).toEqual(['TRADING_PAUSED_BY_USER']);
    expect(resolveEntryAuthority(base({ emergencyStop: true })).reasons).toEqual(['EMERGENCY_STOP']);
    expect(resolveEntryAuthority(base({ settingsReadable: false })).reasons).toEqual(['STRATEGY_SELECTION_UNREADABLE']);
    expect(resolveEntryAuthority(base({ liveEnabled: true })).reasons).toEqual(['PAPER_MODE_REQUIRED']);
    expect(resolveEntryAuthority(base({ tradingMode: 'LIVE' })).reasons).toEqual(['PAPER_MODE_REQUIRED']);
    for (const extra of [{ emergencyStop: true }, { liveEnabled: true }, { tradingMode: 'LIVE' }]) expect(resolveEntryAuthority(base(extra))).toMatchObject({ state: 'TRADING_PAUSED', mayOpenEntries: false });
  });

  it('legacy (flag off): DEFAULT still works unchanged; LIVE is still refused', () => {
    expect(resolveEntryAuthority(base({ mlOnly: false, settings: { strategyMode: 'DEFAULT', modelVersion: null }, model: null }))).toMatchObject({ mayOpenEntries: true, entryStrategy: 'DEFAULT' });
    expect(resolveEntryAuthority(base({ mlOnly: false }))).toMatchObject({ entryStrategy: 'ML', authorizedModelVersion: approved.version });
    expect(resolveEntryAuthority(base({ mlOnly: false, tradingMode: 'LIVE' })).mayOpenEntries).toBe(false);
    expect(selectableStrategies(false)).toEqual(['DEFAULT', 'ML']);
    expect(selectableStrategies(true)).toEqual(['ML']);
  });
});

describe('authorizeEntry (execution-time check)', () => {
  const active = resolveEntryAuthority(base());
  it('only the authorised model; DEFAULT and any other model are refused', () => {
    expect(authorizeEntry(active, { entryStrategy: 'ML', modelVersion: approved.version })).toEqual({ allowed: true });
    expect(authorizeEntry(active, { entryStrategy: 'ML', modelVersion: 'ML-LGBM-COMMUNITY-v1-s42' })).toEqual({ allowed: false, reason: 'ML_MODEL_NOT_SELECTED' });
    expect(authorizeEntry(active, { entryStrategy: 'ML', modelVersion: null })).toEqual({ allowed: false, reason: 'ML_MODEL_NOT_SELECTED' });
    expect(authorizeEntry(active, { entryStrategy: 'DEFAULT' })).toEqual({ allowed: false, reason: 'DEFAULT_STRATEGY_DISABLED' });
  });
  it('no authority: every signal is refused with the state reason', () => {
    expect(authorizeEntry(resolveEntryAuthority(base({ settings: null, model: null })), { entryStrategy: 'DEFAULT' })).toEqual({ allowed: false, reason: 'NO_TRADING_MODEL_SELECTED' });
    expect(authorizeEntry(resolveEntryAuthority(base({ model: null })), { entryStrategy: 'ML', modelVersion: approved.version })).toEqual({ allowed: false, reason: 'MODEL_NOT_FOUND' });
  });
});

describe('input schemas of existing models are unchanged', () => {
  it('ML-FEATURES-v1 (v3 model) and ML-FEATURES-COMMUNITY-v1', () => {
    expect(ML_FEATURE_VERSION).toBe('ML-FEATURES-v1');
    expect(ML_COMMUNITY_FEATURE_VERSION).toBe('ML-FEATURES-COMMUNITY-v1');
    // The exported schema files the trained models were built from must equal the code schema exactly.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'ml', 'schema');
    expect(JSON.parse(readFileSync(path.join(root, 'features-v1.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(mlFeatureSchemaJson())));
    expect(JSON.parse(readFileSync(path.join(root, 'features-community-v1.json'), 'utf8'))).toEqual(JSON.parse(JSON.stringify(mlCommunityFeatureSchemaJson())));
    expect(ML_FEATURE_SCHEMA.some((spec) => spec.group === 'COMMUNITY')).toBe(false);
    expect(ML_COMMUNITY_FEATURE_SCHEMA.slice(0, ML_FEATURE_SCHEMA.length)).toEqual(ML_FEATURE_SCHEMA);
  });
});
