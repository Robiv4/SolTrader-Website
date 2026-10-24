/**
 * Simplified Machine Learning UI logic: training steps only from real pipeline events (no invented progress), status
 * texts, the operating-state banner (no model / paused / unavailable / legacy DEFAULT), model suitability.
 */
import { describe, expect, it } from 'vitest';

import { datasetProgressRows, isJobActive, stepsDone, SUITABILITY_TEXT, tradingBanner, trainingStepStates } from '../app/machine-learning/ml-view';

const log = (...stages: string[]) => stages.map((stage, index) => ({ at: new Date(1_000 * index).toISOString(), stage, message: stage }));

describe('training steps', () => {
  it('queued: nothing done, nothing active (no fake progress)', () => {
    const steps = trainingStepStates({ status: 'QUEUED', log: log('QUEUED') });
    expect(steps.every((step) => step.state === 'pending')).toBe(true);
    expect(stepsDone({ status: 'QUEUED', log: [] })).toBe(0);
  });

  it('running: reported steps done, the last reported one active', () => {
    const steps = trainingStepStates({ status: 'TRAINING', log: log('PREPARING_DATASET', 'ENTRY_MODELS') });
    expect(steps.map((step) => step.state)).toEqual(['done', 'active', 'pending', 'pending', 'pending', 'pending']);
  });

  it('completed: all done; failed: the failing step marked, the rest skipped; cancelled: skipped', () => {
    expect(trainingStepStates({ status: 'COMPLETED', log: log('PREPARING_DATASET') }).every((step) => step.state === 'done')).toBe(true);
    expect(trainingStepStates({ status: 'FAILED', log: log('PREPARING_DATASET', 'ENTRY_MODELS', 'EXIT_MODELS') }).map((step) => step.state)).toEqual(['done', 'done', 'failed', 'skipped', 'skipped', 'skipped']);
    expect(trainingStepStates({ status: 'CANCELLED', log: log('PREPARING_DATASET') }).map((step) => step.state)).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(trainingStepStates({ status: 'SAVING', log: log('PREPARING_DATASET', 'ENTRY_MODELS', 'EXIT_MODELS', 'POSITION_SIZING', 'VALIDATION', 'REGISTERING') }).at(-1)!.state).toBe('active');
  });

  it('active statuses', () => {
    for (const status of ['QUEUED', 'PREPARING_DATASET', 'TRAINING', 'VALIDATING', 'SAVING']) expect(isJobActive(status)).toBe(true);
    for (const status of ['COMPLETED', 'FAILED', 'CANCELLED']) expect(isJobActive(status)).toBe(false);
  });
});

describe('operating-state banner', () => {
  it('no model: data collection only', () => {
    expect(tradingBanner({ state: 'DATA_COLLECTION' }, { mlOnly: true })).toMatchObject({ title: 'Nincs kiválasztott modell' });
    expect(tradingBanner(null, { mlOnly: true }).title).toBe('Nincs kiválasztott modell');
  });
  it('active / paused / unavailable / not loaded / training', () => {
    expect(tradingBanner({ state: 'ML_PAPER_ACTIVE' }, { mlOnly: true, workerLoaded: true }).tone).toBe('positive');
    expect(tradingBanner({ state: 'ML_PAPER_ACTIVE' }, { mlOnly: true, workerLoaded: false, workerError: 'hash mismatch' })).toMatchObject({ tone: 'danger', title: 'A kiválasztott modell nem tölthető be' });
    expect(tradingBanner({ state: 'TRADING_PAUSED' }, { mlOnly: true }).title).toBe('Új belépések szüneteltetve');
    expect(tradingBanner({ state: 'MODEL_UNAVAILABLE', reasons: ['MODEL_NOT_PAPER_APPROVED'] }, { mlOnly: true }).text).toContain('MODEL_NOT_PAPER_APPROVED');
    expect(tradingBanner({ state: 'MODEL_TRAINING' }, { mlOnly: true }).tone).toBe('info');
  });
  it('legacy DEFAULT is shown truthfully (never hidden behind a "no model" text)', () => {
    expect(tradingBanner({ state: 'ML_PAPER_ACTIVE' }, { mlOnly: false, strategyMode: 'DEFAULT' })).toMatchObject({ tone: 'warning', title: 'Régi DEFAULT stratégia aktív' });
  });
});

describe('model suitability', () => {
  it('research models are never shown as selectable', () => {
    for (const code of ['INSUFFICIENT_DATA', 'RESEARCH_ONLY', 'NOT_CHECKED', 'CHECK_RUNNING', 'CHECK_COMPLETE', 'RETIRED']) expect(SUITABILITY_TEXT[code].text).not.toBe('Kereskedésre választható');
    expect(SUITABILITY_TEXT.APPROVED.text).toBe('Kereskedésre választható');
  });
});

describe('dataset preparation progress', () => {
  it('shows only the measured counts reported by the pipeline (nothing when there is no report)', () => {
    expect(datasetProgressRows(null)).toEqual([]);
    const rows = datasetProgressRows({ phase: 'REPLAY', replay: { processed: 1200, total: 84000 }, live: { processed: 0, total: 5000 }, rows: { entry: 1100, position: 12000, replay: 13100, live: 0 }, excluded: 37, csv: { rowsWritten: 0, bytes: 0, chunks: 0 }, heapUsedMb: 143 });
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]));
    expect(byLabel['Fázis']).toBe('Snapshotok feldolgozása – REPLAY sorok');
    expect(byLabel['Feldolgozott ML snapshotok (REPLAY)']).toBe(`${(1200).toLocaleString('hu-HU')} / ${(84000).toLocaleString('hu-HU')}`);
    expect(byLabel['Memória (Node heap)']).toBe('143 MB');
    expect(rows.some((row) => row.value.includes('%'))).toBe(false);
  });
});
