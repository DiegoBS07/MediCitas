import type { Request, Response } from 'express';
import { withTransaction, type DatabaseClient, type DatabasePool } from '@medicitas/kernel';
import type { TenantContext } from '@medicitas/identity';
import type { Logger } from '@medicitas/observability';
import { contextOf, idempotencyKeyOf, requestHash, runIdempotent, sendOutcome, tenantTransaction, type StoredResponse } from '@medicitas/runtime';
import type { AvailabilityChange } from '../../domain/events/scheduler-events.js';
import type { AvailabilityCache } from '../../infrastructure/cache/availability-cache.js';

export const SERVICE = 'scheduler-management';
export const PREFIX = 'sch';

export interface SchedulerHttpDeps {
  readonly pool: DatabasePool;
  readonly cache: AvailabilityCache;
  readonly logger: Logger;
}

export interface MutationResult {
  readonly response: StoredResponse;
  readonly changes: readonly AvailabilityChange[];
}

/**
 * Write route skeleton: one READ COMMITTED transaction (optional Idempotency-Key inside it), then,
 * AFTER COMMIT, best-effort cache invalidation of the affected (professional, dates).
 */
export async function mutate(
  deps: SchedulerHttpDeps,
  req: Request,
  res: Response,
  routeTemplate: string,
  body: unknown,
  work: (client: DatabaseClient, context: TenantContext) => Promise<MutationResult>,
): Promise<void> {
  const context = contextOf(res);
  const key = idempotencyKeyOf(req, false);
  let changes: readonly AvailabilityChange[] = [];
  const outcome = await withTransaction(deps.pool, tenantTransaction(PREFIX, context), (client) => {
    changes = [];
    return runIdempotent(
      client,
      { tenantId: context.tenantId, method: req.method as 'POST' | 'PUT' | 'DELETE', routeTemplate, key, requestHash: requestHash(body) },
      async () => {
        const result = await work(client, context);
        changes = result.changes;
        return result.response;
      },
    );
  });
  await invalidate(deps, context, changes);
  if (outcome.response.status === 204) {
    res.status(204).end();
    return;
  }
  sendOutcome(res, outcome);
}

export async function invalidate(deps: SchedulerHttpDeps, context: TenantContext, changes: readonly AvailabilityChange[]): Promise<void> {
  if (context.tenantId === null) return;
  for (const change of changes) {
    if (change.dates.length > 0) await deps.cache.invalidate(context.tenantId, change.professionalId, change.dates);
  }
}
