import { AppError } from "./types.js";

export class RuntimeGuard {
  private queue: Promise<void> = Promise.resolve();
  private cooldownUntil = 0;
  private readonly lastCallAt = new Map<string, number>();

  public constructor(
    private readonly intervals: Record<string, number>,
    private readonly cooldownMs: number
  ) {}

  public async run<T>(toolName: string, task: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const previous = this.queue;
    this.queue = previous.then(() => gate);
    await previous;

    try {
      const now = Date.now();
      if (now < this.cooldownUntil) {
        throw new AppError("platform_blocked", "cooldown in effect", {
          cooldown_remaining_ms: this.cooldownUntil - now
        });
      }

      await this.enforceInterval(toolName);
      const result = await task();
      this.lastCallAt.set(toolName, Date.now());
      return result;
    } finally {
      release();
    }
  }

  public triggerCooldown(reason: string): void {
    this.cooldownUntil = Date.now() + this.cooldownMs;
    process.stderr.write(`[xhs] cooldown triggered: ${reason}, until=${this.cooldownUntil}\n`);
  }

  private async enforceInterval(toolName: string): Promise<void> {
    const minInterval = this.intervals[toolName] ?? 0;
    if (minInterval <= 0) {
      return;
    }

    const last = this.lastCallAt.get(toolName);
    if (!last) {
      return;
    }

    const waitMs = last + minInterval - Date.now();
    if (waitMs <= 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
