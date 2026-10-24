/**
 * Bounded-memory writer of the Autonomous ML dataset CSV (external merge sort).
 *
 * Rows arrive in source order (replay pages, then live pages). They are buffered up to `chunkRows`, sorted with the
 * dataset order (compareAutonomousRows) and spilled to temporary NDJSON chunk files inside the caller's own work
 * directory. `finish()` k-way merges the chunks into dataset.csv: one line at a time, with backpressure, a streaming
 * SHA-256 and the order-dependent manifest statistics (period, regime order). Memory is O(chunkRows + chunk count),
 * independent of the dataset size; the CSV bytes / order / manifest equal the in-memory buildAutonomousDataset().
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import {
  autonomousCsvHeader, autonomousCsvLine, autonomousRegimeKey, AutonomousDatasetStats, compareAutonomousRows, type AutonomousDatasetRow,
} from '@soltrader/strategy-engine';

export const DEFAULT_SORT_CHUNK_ROWS = 25_000;
/** At most this many chunk files are merged at once (open file handles); more chunks are merged in levels. */
export const MAX_MERGE_FAN_IN = 64;

/** [at, rowId, regimeKey, csvLine] - JSON keeps embedded quotes / newlines of the CSV line intact. */
type ChunkRecord = [number, string, string, string];

const compareRecords = (a: ChunkRecord, b: ChunkRecord) => compareAutonomousRows({ at: a[0], rowId: a[1] }, { at: b[0], rowId: b[1] });

async function write(stream: WriteStream, text: string) {
  if (!stream.write(text)) await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    stream.once('error', onError);
    stream.once('drain', () => {
      stream.off('error', onError);
      resolve();
    });
  });
}

async function close(stream: WriteStream) {
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.end(() => resolve());
  });
}

/** Ascending records of one chunk file, read line by line. */
async function* readChunk(file: string): AsyncGenerator<ChunkRecord> {
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line) as ChunkRecord;
}

/** Min-heap k-way merge of sorted record streams. */
async function* mergeSorted(inputs: Array<AsyncGenerator<ChunkRecord>>): AsyncGenerator<ChunkRecord> {
  const heap: Array<{ record: ChunkRecord; source: number }> = [];
  const less = (i: number, j: number) => {
    const order = compareRecords(heap[i].record, heap[j].record);
    return order < 0 || (order === 0 && heap[i].source < heap[j].source);
  };
  const swap = (i: number, j: number) => {
    [heap[i], heap[j]] = [heap[j], heap[i]];
  };
  const push = (item: { record: ChunkRecord; source: number }) => {
    heap.push(item);
    for (let index = heap.length - 1; index > 0;) {
      const parent = (index - 1) >> 1;
      if (!less(index, parent)) break;
      swap(index, parent);
      index = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let index = 0; ;) {
        const left = 2 * index + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && less(left, smallest)) smallest = left;
        if (right < heap.length && less(right, smallest)) smallest = right;
        if (smallest === index) break;
        swap(index, smallest);
        index = smallest;
      }
    }
    return top;
  };
  for (let source = 0; source < inputs.length; source += 1) {
    const next = await inputs[source].next();
    if (!next.done) push({ record: next.value, source });
  }
  while (heap.length) {
    const top = pop();
    yield top.record;
    const next = await inputs[top.source].next();
    if (!next.done) push({ record: next.value, source: top.source });
  }
}

export interface DatasetWriterProgress { rowsWritten: number; bytes: number; chunks: number }

export interface DatasetWriteResult { csvPath: string; rows: number; bytes: number; fileHash: string; chunks: number }

export class StreamingDatasetWriter {
  readonly stats = new AutonomousDatasetStats();
  private buffer: ChunkRecord[] = [];
  private readonly chunks: string[] = [];
  private spilled = 0;

  constructor(private readonly options: { workDir: string; chunkRows?: number }) {}

  get chunkCount() {
    return this.chunks.length;
  }

  /** Counts the row and buffers its CSV line; spills a sorted chunk file when the buffer is full. */
  async add(row: AutonomousDatasetRow) {
    this.stats.count(row);
    this.buffer.push([row.at, row.rowId, autonomousRegimeKey(row), autonomousCsvLine(row)]);
    if (this.buffer.length >= (this.options.chunkRows ?? DEFAULT_SORT_CHUNK_ROWS)) await this.spill();
  }

  private async spill() {
    if (!this.buffer.length) return;
    const records = this.buffer;
    this.buffer = [];
    records.sort(compareRecords);
    const file = path.join(this.options.workDir, `chunk-${String(this.spilled).padStart(6, '0')}.ndjson`);
    this.spilled += 1;
    const stream = createWriteStream(file, { encoding: 'utf8' });
    for (const record of records) await write(stream, `${JSON.stringify(record)}\n`);
    await close(stream);
    this.chunks.push(file);
  }

  /** Merges levels until at most MAX_MERGE_FAN_IN chunks remain (bounded open files). */
  private async reduceFanIn() {
    while (this.chunks.length > MAX_MERGE_FAN_IN) {
      const group = this.chunks.splice(0, MAX_MERGE_FAN_IN);
      const file = path.join(this.options.workDir, `chunk-${String(this.spilled).padStart(6, '0')}.ndjson`);
      this.spilled += 1;
      const stream = createWriteStream(file, { encoding: 'utf8' });
      for await (const record of mergeSorted(group.map(readChunk))) await write(stream, `${JSON.stringify(record)}\n`);
      await close(stream);
      await Promise.all(group.map((chunk) => rm(chunk, { force: true })));
      this.chunks.push(file);
    }
  }

  /** Writes dataset.csv (header + rows in dataset order) into the work directory; hash and stats are streamed. */
  async finish(onProgress?: (progress: DatasetWriterProgress) => void): Promise<DatasetWriteResult> {
    await this.spill();
    await this.reduceFanIn();
    const csvPath = path.join(this.options.workDir, 'dataset.csv');
    const hash = createHash('sha256');
    const stream = createWriteStream(csvPath, { encoding: 'utf8' });
    let bytes = 0;
    let rows = 0;
    const emit = async (text: string) => {
      hash.update(text, 'utf8');
      bytes += Buffer.byteLength(text, 'utf8');
      await write(stream, text);
    };
    await emit(`${autonomousCsvHeader()}\n`);
    for await (const record of mergeSorted(this.chunks.map(readChunk))) {
      this.stats.ordered(record[0], record[2]);
      await emit(`${record[3]}\n`);
      rows += 1;
      // Mostly already-resolved promises above: yield to timers regularly (job heartbeat, ml:trainer:health).
      if (rows % 5_000 === 0) await new Promise<void>((resolve) => globalThis.setImmediate(resolve));
      if (rows % 50_000 === 0) onProgress?.({ rowsWritten: rows, bytes, chunks: this.chunks.length });
    }
    await close(stream);
    if (rows !== this.stats.rows) throw new Error(`Dataset row count mismatch (${rows} written, ${this.stats.rows} counted)`);
    onProgress?.({ rowsWritten: rows, bytes, chunks: this.chunks.length });
    await Promise.all(this.chunks.map((chunk) => rm(chunk, { force: true })));
    return { csvPath, rows, bytes, fileHash: hash.digest('hex'), chunks: this.chunks.length };
  }
}

/** Streaming SHA-256 of a file (never loads it into memory). */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Small JSON file written in one go (manifest, owner marker). */
export const writeJson = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
