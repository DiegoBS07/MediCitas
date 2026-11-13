import { withTransaction, type DatabasePool } from '@medicitas/kernel';
import type { Logger } from '@medicitas/observability';
import { expire, type SagaSettings } from '../../application/commands/booking-saga.js';
import type { StepName } from '../../domain/entities/booking-saga.js';
import { PgSagaRepository } from '../persistence/pg-saga-repository.js';

const WORKER = { tenantId: null, actorSubject: null, dbRole: 'ao_worker', isolation: 'READ COMMITTED' } as const;

/**
 * Saga recovery (ADR-0006 "Unknown outcomes"): runs at startup and periodically.
 * 1. Unanswered commands are RE-SENT with the same messageId (participants answer duplicates from their inbox).
 * 2. Sagas past their deadline are compensated, and compensations past their window are failed.
 * Discovery is cross-tenant with the worker role; every change runs with the saga tenant's RLS context.
 */
export class SagaSweeper {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly pool: DatabasePool,
    private readonly settings: SagaSettings,
    private readonly logger: Logger,
    private readonly intervalMs = 1_000,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    void this.sweep();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 20));
  }

  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.resendDue();
      await this.expireOverdue();
    } catch (error) {
      this.logger.warn({ err: (error as Error).message }, 'saga sweep failed; retrying on the next tick');
    } finally {
      this.running = false;
    }
  }

  private async resendDue(): Promise<void> {
    const due = await withTransaction(this.pool, { ...WORKER, readOnly: true }, async (client) =>
      (
        await client.query<{ tenant_id: string; saga_id: string; step_name: StepName }>(
          `SELECT tenant_id, saga_id, step_name FROM saga_steps
           WHERE status = 'dispatched' AND next_attempt_at <= clock_timestamp() ORDER BY next_attempt_at LIMIT 100`,
        )
      ).rows,
    );
    for (const step of due) {
      const commandId = await withTransaction(
        this.pool,
        { tenantId: step.tenant_id, actorSubject: null, dbRole: 'ao_system', isolation: 'READ COMMITTED' },
        (client) => new PgSagaRepository(client).claimResend(step.saga_id, step.step_name, this.settings.resendMs),
      );
      if (commandId === null) continue;
      // Same messageId → the participant's inbox treats it as a duplicate and re-publishes its stored reply.
      await withTransaction(this.pool, WORKER, (client) =>
        client.query('UPDATE outbox_messages SET published_at = NULL, available_at = clock_timestamp() WHERE id = $1', [commandId]),
      );
      this.logger.info({ sagaId: step.saga_id, step: step.step_name }, 'saga command re-sent');
    }
  }

  private async expireOverdue(): Promise<void> {
    const overdue = await withTransaction(this.pool, { ...WORKER, readOnly: true }, async (client) =>
      (
        await client.query<{ id: string; tenant_id: string }>(
          `SELECT id, tenant_id FROM saga_instances
           WHERE status NOT IN ('completed', 'failed') AND deadline_at <= clock_timestamp() ORDER BY deadline_at LIMIT 100`,
        )
      ).rows,
    );
    for (const saga of overdue) {
      await withTransaction(
        this.pool,
        { tenantId: saga.tenant_id, actorSubject: null, dbRole: 'ao_system', isolation: 'READ COMMITTED' },
        (client) => expire(client, this.settings, saga.id, this.logger),
      );
    }
  }
}
