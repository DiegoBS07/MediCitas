import { randomUUID } from 'node:crypto';
import { withTransaction, type DatabasePool } from '@medicitas/kernel';
import { requestEventSink } from '@medicitas/messaging';
import type { Logger } from '@medicitas/observability';
import { releaseSlot } from '../../application/commands/booking.js';
import type { AvailabilityCache } from '../cache/availability-cache.js';
import { PgSchedulerRepository } from '../persistence/pg-scheduler-repository.js';

const SYSTEM_ACTOR = { subject: 'system:scheduler-management', roles: ['system' as const] };

/**
 * Releases holds whose TTL passed (ADR-0006): a slot can never stay blocked because an
 * orchestrator died. Discovery is cross-tenant with the worker role (column-limited, read-only on
 * appointments); each release runs in its own transaction with the tenant's RLS context and the
 * system role. releaseSlot follows the global lock order (versions → appointment row) and re-checks
 * the status under the row lock, so concurrent sweepers (replicas) or a late confirm resolve safely.
 */
export class HoldExpirySweeper {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly pool: DatabasePool,
    private readonly cache: AvailabilityCache,
    private readonly logger: Logger,
    private readonly intervalMs = 5_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    void this.sweep();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let released = 0;
    try {
      const expired = await withTransaction(
        this.pool,
        { tenantId: null, actorSubject: null, dbRole: 'sch_worker', isolation: 'READ COMMITTED', readOnly: true },
        async (client) =>
          (
            await client.query<{ id: string; tenant_id: string }>(
              `SELECT id, tenant_id FROM appointments WHERE status = 'held' AND hold_expires_at <= now() ORDER BY hold_expires_at LIMIT 100`,
            )
          ).rows,
      );
      for (const hold of expired) {
        const result = await withTransaction(
          this.pool,
          { tenantId: hold.tenant_id, actorSubject: null, dbRole: 'sch_system', isolation: 'READ COMMITTED' },
          async (client) => {
            const repository = new PgSchedulerRepository(client);
            const events = requestEventSink(client, {
              producer: 'scheduler-management',
              tenantId: hold.tenant_id,
              actor: SYSTEM_ACTOR,
              correlationId: randomUUID(),
            });
            return releaseSlot(repository, events, { appointmentId: hold.id, reasonCode: 'HOLD_EXPIRED' });
          },
        );
        if (result?.released === true && result.change !== null) {
          released += 1;
          await this.cache.invalidate(hold.tenant_id, result.change.professionalId, result.change.dates);
        }
      }
      if (released > 0) this.logger.info({ released }, 'expired holds released');
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, 'hold expiry sweep failed; retrying on the next tick');
    } finally {
      this.running = false;
    }
    return released;
  }
}
