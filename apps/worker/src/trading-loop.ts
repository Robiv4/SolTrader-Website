import type { BotCommand, BotCommandSubscriber } from '@soltrader/shared';

export type WorkerBotStatus = 'RUNNING' | 'PAUSED' | 'STOPPED' | 'EMERGENCY_STOP';
type WorkerAbortSignal = ReturnType<typeof createAbortController>['signal'];

function createAbortController() {
  return new globalThis.AbortController();
}

/**
 * Hooks of one RUNNING cycle. Discovery and entry decisions come from the event-driven New Launch service; the loop
 * executes its PAPER signals and protects open positions (the legacy token monitor / strategy hooks were retired).
 */
export interface TradingLoopHooks {
  runPaperExecution(signal: WorkerAbortSignal): Promise<void>;
  monitorOpenPositions(signal: WorkerAbortSignal): Promise<void>;
  cancelPendingOffers(reason: 'STOP' | 'EMERGENCY_STOP'): Promise<void>;
}

export interface TradingLoopStore {
  readState(): Promise<{ status: WorkerBotStatus } | null>;
  writeState(status: WorkerBotStatus, updatedBy?: string): Promise<void>;
  recordEvent(action: string, details: Record<string, unknown>): Promise<void>;
}

export interface TradingLoopLogger {
  info(bindings: object, message: string): void;
  warn(bindings: object, message: string): void;
  error(bindings: object, message: string): void;
}

const defaultHooks: TradingLoopHooks = {
  runPaperExecution: async () => undefined,
  monitorOpenPositions: async () => undefined,
  cancelPendingOffers: async () => undefined,
};

export class BotTradingLoop {
  private status: WorkerBotStatus = 'STOPPED';
  private stopRequested = false;
  private cycleAbortController = createAbortController();
  private wakeResolver?: () => void;
  private runPromise?: Promise<void>;

  constructor(
    private readonly store: TradingLoopStore,
    private readonly subscriber: Pick<BotCommandSubscriber, 'subscribe'>,
    private readonly hooks: TradingLoopHooks = defaultHooks,
    private readonly intervalMs = 5000,
    private readonly logger: TradingLoopLogger = console,
  ) {}

  get currentStatus() { return this.status; }

  async start() {
    const savedState = await this.store.readState();
    this.status = savedState?.status ?? 'STOPPED';
    await this.subscriber.subscribe((command) => this.handleCommand(command));
    this.stopRequested = false;
    this.runPromise = this.run();
  }

  async stop() {
    this.stopRequested = true;
    this.abortCycle();
    this.wake();
    await this.runPromise;
  }

  async resyncFromStore() {
    const savedState = await this.store.readState();
    if (savedState) {
      this.status = savedState.status;
      if (this.status === 'STOPPED' || this.status === 'EMERGENCY_STOP') this.abortCycle();
      else this.cycleAbortController = createAbortController();
      this.wake();
    }
    return this.status;
  }

  private async handleCommand(command: BotCommand) {
    const requestedBy = command.payload.requestedBy;
    try {
      switch (command.command) {
        case 'START':
          await this.setStatus('RUNNING', requestedBy);
          break;
        case 'PAUSE':
          await this.setStatus('PAUSED', requestedBy);
          break;
        case 'STOP':
          await this.setStatus('STOPPED', requestedBy);
          await this.hooks.cancelPendingOffers('STOP');
          break;
        case 'EMERGENCY_STOP':
          await this.setStatus('EMERGENCY_STOP', requestedBy);
          await this.hooks.cancelPendingOffers('EMERGENCY_STOP');
          await this.store.recordEvent('EMERGENCY_STOP', { reason: command.payload.reason ?? 'Redis command', requestedBy });
          break;
        case 'UPDATE_STRATEGY_CONFIG':
          await this.store.recordEvent('UPDATE_STRATEGY_CONFIG', {
            strategyName: command.payload.strategyName,
            isEnabled: command.payload.isEnabled,
            requestedBy,
          });
          break;
      }
    } catch (error) {
      this.logger.error({ err: error, command: command.command }, 'Failed to process bot command');
    } finally {
      this.wake();
    }
  }

  private async setStatus(status: WorkerBotStatus, updatedBy?: string) {
    this.status = status;
    this.abortCycle();
    await this.store.writeState(status, updatedBy);
    await this.store.recordEvent(`BOT_${status}`, { status, updatedBy });
  }

  private abortCycle() {
    this.cycleAbortController.abort();
    this.cycleAbortController = createAbortController();
  }

  private wake() {
    const resolver = this.wakeResolver;
    this.wakeResolver = undefined;
    resolver?.();
  }

  private waitForWakeOrInterval() {
    return new Promise<void>((resolve) => {
      const timer = globalThis.setTimeout(resolve, this.intervalMs);
      this.wakeResolver = () => {
        globalThis.clearTimeout(timer);
        resolve();
      };
    });
  }

  private async run() {
    while (!this.stopRequested) {
      try {
        if (this.status === 'RUNNING') {
          await this.runRunningCycle();
        } else if (this.status === 'PAUSED' || this.status === 'STOPPED') {
          // STOP only halts new entries; positions that are still open keep their stop-loss/take-profit protection.
          await this.runPausedCycle();
        }
      } catch (error) {
        if (!this.cycleAbortController.signal.aborted) {
          this.logger.error({ err: error, status: this.status }, 'Trading loop cycle failed');
          try {
            await this.store.recordEvent('TRADING_LOOP_ERROR', { status: this.status, message: error instanceof Error ? error.message : String(error) });
          } catch (recordError) {
            this.logger.error({ err: recordError }, 'Failed to record trading loop error');
          }
        }
      }
      if (!this.stopRequested) await this.waitForWakeOrInterval();
    }
  }

  private async runRunningCycle() {
    const signal = this.cycleAbortController.signal;
    await this.hooks.runPaperExecution(signal);
    if (signal.aborted || this.status !== 'RUNNING') return;
    await this.hooks.monitorOpenPositions(signal);
  }

  private async runPausedCycle() {
    const signal = this.cycleAbortController.signal;
    await this.hooks.monitorOpenPositions(signal);
  }
}
