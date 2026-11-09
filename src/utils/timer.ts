/**
 * Timer utility for driving session countdowns.
 *
 * A simple interval-based engine that fires an `onTick` callback at a
 * configurable interval. Used by the session store to update elapsed
 * time and trigger block transitions.
 *
 * The timer runs via `setInterval` and is NOT tied to React's render cycle —
 * the store subscribes to ticks and batches state updates.
 */

export class TimerEngine {
  /** Handle returned by setInterval, or null when stopped */
  private intervalId: ReturnType<typeof setInterval> | null = null;

  /** Callback invoked on every tick */
  private readonly onTick: () => void;

  /** Milliseconds between ticks (default: 1000ms) */
  private readonly intervalMs: number;

  /**
   * @param onTick     — Function called on each interval tick.
   * @param intervalMs — Tick interval in milliseconds (default 1000).
   */
  constructor(onTick: () => void, intervalMs: number = 1_000) {
    this.onTick = onTick;
    this.intervalMs = intervalMs;
  }

  /**
   * Start the timer. If already running, this is a no-op to prevent
   * multiple intervals from stacking up.
   */
  start(): void {
    if (this.intervalId !== null) {
      return; // Already running
    }

    this.intervalId = setInterval(() => {
      this.onTick();
    }, this.intervalMs);
  }

  /**
   * Stop the timer. Safe to call even when not running.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Returns `true` if the timer is currently running.
   */
  isActive(): boolean {
    return this.intervalId !== null;
  }
}
