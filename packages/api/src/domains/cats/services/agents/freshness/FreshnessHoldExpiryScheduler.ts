import type { IFreshnessHoldStore } from '../../stores/ports/FreshnessHoldStore.js';

const DEFAULT_INTERVAL_MS = 60_000;

export interface FreshnessHoldExpirySchedulerOptions {
  holdStore: Pick<IFreshnessHoldStore, 'expireDue'>;
  intervalMs?: number;
  now?: () => number;
  setIntervalFn?: (callback: () => Promise<void>, intervalMs: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  log?: { warn(message: string): void };
}

/** Periodically moves overdue held/reviewing records into fail-closed needs_attention. */
export class FreshnessHoldExpiryScheduler {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setIntervalFn: (callback: () => Promise<void>, intervalMs: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private timer: unknown;
  private started = false;
  private sweepInFlight: Promise<void> | null = null;

  constructor(private readonly options: FreshnessHoldExpirySchedulerOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.setIntervalFn =
      options.setIntervalFn ?? ((callback, intervalMs) => setInterval(() => void callback(), intervalMs));
    this.clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
  }

  get isRunning(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.sweep();
    if (!this.started) return;
    this.timer = this.setIntervalFn(async () => {
      if (!this.started) return;
      await this.sweep();
    }, this.intervalMs);
  }

  stop(): void {
    this.started = false;
    if (this.timer !== undefined) {
      this.clearIntervalFn(this.timer);
      this.timer = undefined;
    }
  }

  private sweep(): Promise<void> {
    if (this.sweepInFlight) return this.sweepInFlight;
    this.sweepInFlight = this.options.holdStore
      .expireDue(this.now())
      .then(() => undefined)
      .catch((error: unknown) => {
        this.options.log?.warn(`[freshness-hold] expiry sweep failed: ${String(error)}`);
      })
      .finally(() => {
        this.sweepInFlight = null;
      });
    return this.sweepInFlight;
  }
}
