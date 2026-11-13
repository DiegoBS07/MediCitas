import type { Response, Router } from 'express';
import { z } from 'zod';
import { NotFoundError, newId, withTransaction, type DatabasePool, type TransactionContext } from '@medicitas/kernel';
import { requirePermission, type EphemeralSecrets, type TenantContext } from '@medicitas/identity';
import {
  PgSagaStore,
  attachOperation,
  beginIdempotent,
  contextOf,
  idempotencyKeyOf,
  parseInput,
  pathParams,
  problem,
  requestHash,
  sendData,
  uuidSchema,
  waitForSaga,
  type SagaRecord,
  type SagaTables,
} from '@medicitas/runtime';
import { httpStatusOf } from '../../domain/onboarding.js';
import { sendCommand, type OnboardingSettings } from '../../application/onboarding-saga.js';

const ROUTE = '/api/v1/tenants';

const onboardingBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, 'must match ^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
    timezone: z.string().min(1).max(64),
    firstAdmin: z
      .object({
        email: z.email().max(254),
        firstName: z.string().trim().min(1).max(80),
        lastName: z.string().trim().min(1).max(80),
        temporaryPassword: z.string().min(12).max(128),
      })
      .strict(),
  })
  .strict();

export interface HttpSettings extends OnboardingSettings {
  readonly deadlineMs: number;
  readonly syncWaitMs: number;
}

/** Control-plane transactions: no tenant context, platform DB role (ADR-0009). */
const platform = (context: TenantContext, readOnly = false): TransactionContext => ({
  tenantId: null,
  actorSubject: context.subject,
  dbRole: 'onb_platform_admin',
  isolation: 'READ COMMITTED',
  ...(readOnly ? { readOnly: true } : {}),
});

function operationView(saga: SagaRecord) {
  const status = saga.status === 'completed' ? 'completed' : saga.status === 'failed' ? 'failed' : 'running';
  return {
    operationId: saga.id,
    type: 'tenant-onboarding',
    status,
    result: status === 'completed' ? saga.result : null,
    error: status === 'failed' ? { code: saga.errorCode, detail: saga.errorDetail } : null,
    createdAt: saga.createdAt.toISOString(),
    updatedAt: saga.updatedAt.toISOString(),
  };
}

/** RF1 (api-contracts §3.2): POST /tenants starts the onboarding saga; operations are pollable. */
export function onboardingRoutes(pool: DatabasePool, tables: SagaTables, secrets: EphemeralSecrets, settings: HttpSettings) {
  const read = (context: TenantContext, sagaId: string): Promise<SagaRecord | null> =>
    withTransaction(pool, platform(context, true), (client) => new PgSagaStore(client, tables).find(sagaId));

  function respond(res: Response, saga: SagaRecord | null, sagaId: string, replayed: boolean, correlationId: string): void {
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    if (saga?.status === 'completed' && saga.result !== null) {
      res.setHeader('Location', `/api/v1/tenants/${String(saga.result['tenantId'])}`);
      sendData(res, 201, saga.result);
      return;
    }
    if (saga?.status === 'failed' && saga.errorCode !== null) {
      const body = problem(httpStatusOf(saga.errorCode), saga.errorCode, saga.errorDetail ?? saga.errorCode, correlationId);
      if (body.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(body.retryAfterSeconds));
      res.status(body.status).type('application/problem+json').json(body.body);
      return;
    }
    res.setHeader('Location', `/api/v1/tenant-onboardings/${sagaId}`);
    sendData(res, 202, { operationId: sagaId, status: 'running' });
  }

  return (router: Router): void => {
    router.post(ROUTE, async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'tenants:onboard');
      const key = idempotencyKeyOf(req, true) as string;
      const body = parseInput(onboardingBody, req.body, 'body');
      const { temporaryPassword, ...firstAdmin } = body.firstAdmin;
      const request = { name: body.name, slug: body.slug, timezone: body.timezone, firstAdmin: { ...firstAdmin, email: firstAdmin.email.toLowerCase() } };
      const sagaId = newId();
      // Never persisted: kept in memory until the Keycloak step uses it (ADR-0012).
      secrets.put(sagaId, temporaryPassword);
      let started: { readonly sagaId: string; readonly replayed: boolean };
      try {
        started = await withTransaction(pool, platform(context), async (client) => {
          const claim = await beginIdempotent(client, { tenantId: null, method: 'POST', routeTemplate: ROUTE, key, requestHash: requestHash(body) });
          if (claim.kind !== 'new') {
            const operationId = claim.kind === 'in_progress' ? claim.operationId : null;
            if (operationId === null) throw new NotFoundError('operation', 'The original operation is no longer available.');
            return { sagaId: operationId, replayed: true };
          }
          await client.query(
            `INSERT INTO saga_instances (id, request, actor_subject, correlation_id, deadline_at)
             VALUES ($1, $2, $3, $4, clock_timestamp() + make_interval(secs => $5::double precision / 1000))`,
            [sagaId, JSON.stringify(request), context.subject, context.correlationId, settings.deadlineMs],
          );
          const store = new PgSagaStore(client, tables);
          const saga = { id: sagaId, tenantId: null, actorSubject: context.subject, correlationId: context.correlationId };
          await sendCommand(client, store, saga, 'create_tenant', { name: request.name, slug: request.slug, timezone: request.timezone }, settings, true);
          await attachOperation(client, claim.recordId, sagaId);
          return { sagaId, replayed: false };
        });
      } catch (error) {
        secrets.delete(sagaId);
        throw error;
      }
      if (started.replayed) secrets.delete(sagaId);
      const saga = await waitForSaga(() => read(context, started.sagaId), settings.syncWaitMs);
      respond(res, saga, started.sagaId, started.replayed, context.correlationId);
    });

    router.get('/api/v1/tenant-onboardings/:operationId', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'tenants:read');
      const { operationId } = parseInput(pathParams({ operationId: uuidSchema }), req.params, 'params');
      const saga = await read(context, operationId);
      if (saga === null) throw new NotFoundError('operation', 'Operation not found.');
      sendData(res, 200, operationView(saga));
    });
  };
}
