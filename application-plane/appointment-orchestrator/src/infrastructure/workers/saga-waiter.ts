import type { DatabaseClient, DatabasePool } from '@medicitas/kernel';
import type { Logger } from '@medicitas/observability';

/**
 * Wakes HTTP handlers waiting for a saga to finish. Any replica may finalize a saga;
 * the trigger saga_instances_notify_terminal issues NOTIFY saga_terminal, received here through
 * LISTEN. Polling is the fallback, so a lost notification only delays the answer.
 */
export class SagaWaiter {
  private listener: DatabaseClient | undefined;
  private readonly waiting = new Map<string, Set<() => void>>();

  constructor(
    private readonly pool: DatabasePool,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    try {
      this.listener = await this.pool.connect();
      this.listener.on('notification', (notification) => {
        if (notification.channel !== 'saga_terminal' || notification.payload === undefined) return;
        for (const wake of this.waiting.get(notification.payload) ?? []) wake();
      });
      await this.listener.query('LISTEN saga_terminal');
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, 'LISTEN saga_terminal unavailable; polling only');
    }
  }

  async stop(): Promise<void> {
    if (this.listener === undefined) return;
    try {
      await this.listener.query('UNLISTEN saga_terminal');
    } finally {
      this.listener.release();
      this.listener = undefined;
    }
  }

  /** Resolves with `check()`'s value once it is not null, or with null after `timeoutMs`. */
  async waitFor<T>(sagaId: string, timeoutMs: number, check: () => Promise<T | null>): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value !== null) return value;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          this.waiting.get(sagaId)?.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, Math.min(remaining, 500));
        const set = this.waiting.get(sagaId) ?? new Set<() => void>();
        set.add(wake);
        this.waiting.set(sagaId, set);
      });
      if (this.waiting.get(sagaId)?.size === 0) this.waiting.delete(sagaId);
    }
  }
}
