/**
 * Pure view logic of the simplified Machine Learning UI (no React): training job stages from the REAL events the
 * pipeline reported, Hungarian status texts, the operating-state banner and model suitability. Unit tested.
 */

export interface JobLike {
  status: string;
  stage?: string | null;
  error?: string | null;
  log?: Array<{ at: string; stage: string; message: string }> | null;
  cancelRequested?: boolean;
}

export const TRAINING_STEPS = [
  { key: 'PREPARING_DATASET', label: 'Dataset előkészítése' },
  { key: 'ENTRY_MODELS', label: 'Entry modell tanítása' },
  { key: 'EXIT_MODELS', label: 'Exit modell tanítása' },
  { key: 'POSITION_SIZING', label: 'Pozícióméretezés (szabály a modellkimenetekből)' },
  { key: 'VALIDATION', label: 'Validáció' },
  { key: 'SAVING', label: 'Modell mentése' },
] as const;

const ACTIVE = new Set(['QUEUED', 'PREPARING_DATASET', 'TRAINING', 'VALIDATING', 'SAVING']);
export const isJobActive = (status: string) => ACTIVE.has(status);

export const JOB_STATUS_TEXT: Record<string, { text: string; tone: string }> = {
  QUEUED: { text: 'Sorban áll', tone: 'neutral' }, PREPARING_DATASET: { text: 'Dataset előkészítése', tone: 'info' }, TRAINING: { text: 'Tanítás', tone: 'info' },
  VALIDATING: { text: 'Validáció', tone: 'info' }, SAVING: { text: 'Mentés', tone: 'info' }, COMPLETED: { text: 'Elkészült', tone: 'positive' },
  FAILED: { text: 'Sikertelen', tone: 'danger' }, CANCELLED: { text: 'Megszakítva', tone: 'warning' },
};

export type StepState = 'done' | 'active' | 'pending' | 'failed' | 'skipped';

/**
 * Step states only from what the pipeline really reported (log stages). No percentage, no time estimate: a step is
 * done when a later step was reported or the job completed; the last reported step is active while the job runs.
 */
export function trainingStepStates(job: JobLike): Array<{ key: string; label: string; state: StepState }> {
  const reported = new Set((job.log ?? []).map((entry) => (entry.stage === 'REGISTERING' ? 'SAVING' : entry.stage)));
  const order = TRAINING_STEPS.map((step) => step.key as string);
  const lastIndex = order.reduce((last, key, index) => (reported.has(key) ? index : last), -1);
  return TRAINING_STEPS.map((step, index) => {
    let state: StepState = 'pending';
    if (job.status === 'COMPLETED') state = 'done';
    else if (index < lastIndex) state = 'done';
    else if (index === lastIndex) state = isJobActive(job.status) ? 'active' : job.status === 'FAILED' ? 'failed' : job.status === 'CANCELLED' ? 'skipped' : 'done';
    else if (!isJobActive(job.status)) state = 'skipped';
    return { key: step.key, label: step.label, state };
  });
}

export interface DatasetProgressLike {
  phase: string;
  replay: { processed: number; total: number };
  live: { processed: number; total: number };
  rows: { entry: number; position: number; replay: number; live: number };
  excluded: number;
  csv: { rowsWritten: number; bytes: number; chunks: number };
  heapUsedMb: number;
}

const DATASET_PHASE_TEXT: Record<string, string> = {
  COUNTING: 'Források számlálása', REPLAY: 'Snapshotok feldolgozása – REPLAY sorok', LIVE: 'LIVE sorok előállítása', WRITING_CSV: 'CSV írása',
  MANIFEST: 'Manifest és checksum készítése', REGISTERING: 'Dataset regisztrálása', DONE: 'Dataset kész',
};
const count = (value: number) => value.toLocaleString('hu-HU');

/** Measured dataset-preparation counts as label / value rows (only real numbers from the pipeline, no percentages). */
export function datasetProgressRows(progress: DatasetProgressLike | null | undefined): Array<{ label: string; value: string }> {
  if (!progress) return [];
  return [
    { label: 'Fázis', value: DATASET_PHASE_TEXT[progress.phase] ?? progress.phase },
    { label: 'Feldolgozott ML snapshotok (REPLAY)', value: `${count(progress.replay.processed)} / ${count(progress.replay.total)}` },
    { label: 'Feldolgozott döntési snapshotok (LIVE)', value: `${count(progress.live.processed)} / ${count(progress.live.total)}` },
    { label: 'ENTRY / POSITION sorok', value: `${count(progress.rows.entry)} / ${count(progress.rows.position)}` },
    { label: 'REPLAY / LIVE sorok', value: `${count(progress.rows.replay)} / ${count(progress.rows.live)}` },
    { label: 'Kizárt minták', value: count(progress.excluded) },
    { label: 'CSV-be írt sorok', value: `${count(progress.csv.rowsWritten)} (${(progress.csv.bytes / 1_048_576).toFixed(1)} MB, ${count(progress.csv.chunks)} rendezett darab)` },
    { label: 'Memória (Node heap)', value: `${count(progress.heapUsedMb)} MB` },
  ];
}

export function stepsDone(job: JobLike) {
  return trainingStepStates(job).filter((step) => step.state === 'done').length;
}

export interface TradingStateLike { state: string; reasons?: string[] }

/** Banner for the operating state (what the user must know at a glance). */
export function tradingBanner(tradingState: TradingStateLike | null | undefined, options: { mlOnly: boolean; strategyMode?: string; workerLoaded?: boolean | null; workerError?: string | null }) {
  if (!options.mlOnly && options.strategyMode === 'DEFAULT') {
    return { tone: 'warning', title: 'Régi DEFAULT stratégia aktív', text: 'Az ML-only mód ki van kapcsolva a szerveren (ML_ONLY_ARCHITECTURE_ENABLED=false), ezért ennél a fióknál a régi szabályalapú stratégia kereskedhet. Válaszd a „Nincs modell – csak adatgyűjtés” vagy egy jóváhagyott modell beállítást.' };
  }
  switch (tradingState?.state) {
    case 'ML_PAPER_ACTIVE':
      if (options.workerLoaded === false) return { tone: 'danger', title: 'A kiválasztott modell nem tölthető be', text: `A worker nem tudja használni a modellt${options.workerError ? ` (${options.workerError})` : ''}: új belépés nincs, a nyitott pozíciókat a kötelező védelem kezeli.` };
      return { tone: 'positive', title: 'PAPER kereskedés aktív', text: 'A kiválasztott, jóváhagyott modell önállóan dönt a PAPER belépésekről és kilépésekről; a kötelező biztonsági korlátok mindig érvényesek.' };
    case 'TRADING_PAUSED':
      return { tone: 'warning', title: 'Új belépések szüneteltetve', text: 'Nincs új belépés. Az adatgyűjtés és a nyitott pozíciók védelme folytatódik.' };
    case 'MODEL_UNAVAILABLE':
      return { tone: 'danger', title: 'A kiválasztott modell nem használható', text: `A modell nem érhető el vagy vissza lett vonva (${(tradingState.reasons ?? []).join(', ') || 'ismeretlen ok'}). Új pozíció nem nyílik; alapstratégiára nincs visszaváltás.` };
    case 'MODEL_TRAINING':
      return { tone: 'info', title: 'Nincs kiválasztott modell – tanítás folyamatban', text: 'A rendszer adatot gyűjt, és a háttérben új modell tanul. Kereskedés nincs.' };
    default:
      return { tone: 'neutral', title: 'Nincs kiválasztott modell', text: 'A rendszer csak adatot gyűjt, új pozíciót nem nyit.' };
  }
}

export const SUITABILITY_TEXT: Record<string, { text: string; tone: string; help: string }> = {
  INSUFFICIENT_DATA: { text: 'Kevés adat – kutatási modell', tone: 'danger', help: 'Túl kevés tanítóadatból készült; kereskedésre nem választható.' },
  RESEARCH_ONLY: { text: 'Kutatási modell', tone: 'warning', help: 'A teszteredmények alapján nem alkalmas kereskedésre; nem választható ki.' },
  NOT_CHECKED: { text: 'Ellenőrzésre vár', tone: 'info', help: 'A tesztek alapján alkalmas lehet. Következő lépés: „Modell ellenőrzése” (döntések végrehajtás nélkül).' },
  CHECK_RUNNING: { text: 'Ellenőrzés folyamatban', tone: 'info', help: 'A modell döntéseket hoz végrehajtás nélkül; a jóváhagyáshoz elég ellenőrzési döntés kell.' },
  CHECK_COMPLETE: { text: 'Jóváhagyásra kész', tone: 'info', help: 'Az ellenőrzés elég döntést gyűjtött; adminisztrátori jóváhagyás után választható ki.' },
  APPROVED: { text: 'Kereskedésre választható', tone: 'positive', help: 'Jóváhagyott modell; a Beállításokban választható ki aktív modellnek.' },
  RETIRED: { text: 'Kivezetve', tone: 'neutral', help: 'Nem használható.' },
};
