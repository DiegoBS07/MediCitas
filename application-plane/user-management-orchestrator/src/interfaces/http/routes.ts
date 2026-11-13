import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { ConflictError, NotFoundError, newId, pgErrorInfo, withTransaction, type DatabaseClient, type DatabasePool } from '@medicitas/kernel';
import { requirePermission, requireTenant, type EphemeralSecrets, type TenantContext } from '@medicitas/identity';
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
  tenantTransaction,
  uuidSchema,
  waitForSaga,
  type SagaRecord,
  type SagaTables,
} from '@medicitas/runtime';
import { CLINIC_ROLES, SAGA_TYPES, httpStatusOf, type CommandStep } from '../../domain/provisioning.js';
import { sendCommand, type ProvisioningSettings } from '../../application/provisioning-saga.js';

const PREFIX = 'umo';

const createBody = z
  .object({
    email: z.email().max(254),
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    // platform_admin is never assignable from the application plane (400).
    role: z.enum(CLINIC_ROLES),
    temporaryPassword: z.string().min(12).max(128),
  })
  .strict();
const roleBody = z.object({ role: z.enum(CLINIC_ROLES) }).strict();
const userParams = pathParams({ userId: uuidSchema });

export interface HttpSettings extends ProvisioningSettings {
  readonly deadlineMs: number;
  readonly syncWaitMs: number;
}

function operationView(saga: SagaRecord) {
  const status = saga.status === 'completed' ? 'completed' : saga.status === 'failed' ? 'failed' : 'running';
  return {
    operationId: saga.id,
    type: saga.sagaType,
    status,
    result: status === 'completed' ? saga.result : null,
    error: status === 'failed' ? { code: saga.errorCode, detail: saga.errorDetail } : null,
    createdAt: saga.createdAt.toISOString(),
    updatedAt: saga.updatedAt.toISOString(),
  };
}

/** RF2 writes: each one is a provisioning saga; reads are served by user-management. */
export function provisioningRoutes(pool: DatabasePool, tables: SagaTables, secrets: EphemeralSecrets, settings: HttpSettings) {
  const read = (context: TenantContext, sagaId: string): Promise<SagaRecord | null> =>
    withTransaction(pool, tenantTransaction(PREFIX, context, { readOnly: true }), (client) => new PgSagaStore(client, tables).find(sagaId));

  function respond(res: Response, saga: SagaRecord | null, sagaId: string, replayed: boolean, createdStatus: number, correlationId: string): void {
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    if (saga?.status === 'completed' && saga.result !== null) {
      const userId = String(saga.result['userId']);
      if (createdStatus === 201) res.setHeader('Location', `/api/v1/users/${userId}`);
      sendData(res, createdStatus, saga.result);
      return;
    }
    if (saga?.status === 'failed' && saga.errorCode !== null) {
      const body = problem(httpStatusOf(saga.errorCode), saga.errorCode, saga.errorDetail ?? saga.errorCode, correlationId);
      if (body.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(body.retryAfterSeconds));
      res.status(body.status).type('application/problem+json').json(body.body);
      return;
    }
    res.setHeader('Location', `/api/v1/user-operations/${sagaId}`);
    sendData(res, 202, { operationId: sagaId, status: 'running' });
  }

  /**
   * Starts a saga in one transaction: optional/required Idempotency-Key, saga row, first command
   * (outbox). A second running saga for the same user is refused (409 OPERATION_IN_PROGRESS).
   */
  async function start(
    req: Request,
    res: Response,
    input: {
      readonly routeTemplate: string;
      readonly keyRequired: boolean;
      readonly body: unknown;
      readonly sagaType: string;
      readonly targetUserId: string;
      readonly request: Readonly<Record<string, unknown>>;
      readonly firstStep: CommandStep;
      readonly firstPayload: Readonly<Record<string, unknown>>;
      readonly createdStatus: number;
      readonly secret?: string;
    },
  ): Promise<void> {
    const context = contextOf(res);
    requirePermission(context, 'users:manage');
    const tenantId = requireTenant(context);
    const key = idempotencyKeyOf(req, input.keyRequired);
    const sagaId = newId();
    if (input.secret !== undefined) secrets.put(sagaId, input.secret);
    let started: { readonly sagaId: string; readonly replayed: boolean };
    try {
      started = await withTransaction(pool, tenantTransaction(PREFIX, context), async (client: DatabaseClient) => {
        let recordId: string | null = null;
        if (key !== null) {
          const claim = await beginIdempotent(client, {
            tenantId,
            method: req.method as 'POST' | 'PATCH',
            routeTemplate: input.routeTemplate,
            key,
            requestHash: requestHash(input.body),
          });
          if (claim.kind !== 'new') {
            const operationId = claim.kind === 'in_progress' ? claim.operationId : null;
            if (operationId === null) throw new NotFoundError('operation', 'The original operation is no longer available.');
            return { sagaId: operationId, replayed: true };
          }
          recordId = claim.recordId;
        }
        try {
          await client.query('SAVEPOINT saga_insert');
          await client.query(
            `INSERT INTO saga_instances (id, tenant_id, saga_type, target_user_id, request, actor_subject, correlation_id, deadline_at)
             VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, clock_timestamp() + make_interval(secs => $7::double precision / 1000))`,
            [sagaId, input.sagaType, input.targetUserId, JSON.stringify(input.request), context.subject, context.correlationId, settings.deadlineMs],
          );
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT saga_insert');
          if (pgErrorInfo(error).constraint === 'saga_instances_one_open_per_user') {
            throw new ConflictError('OPERATION_IN_PROGRESS', 'Another operation on this user is still running.');
          }
          throw error;
        }
        const store = new PgSagaStore(client, tables);
        const saga = { id: sagaId, tenantId, actorSubject: context.subject, correlationId: context.correlationId };
        await sendCommand(client, store, saga, input.firstStep, input.firstPayload, settings, true);
        if (recordId !== null) await attachOperation(client, recordId, sagaId);
        return { sagaId, replayed: false };
      });
    } catch (error) {
      secrets.delete(sagaId);
      throw error;
    }
    if (started.replayed) secrets.delete(sagaId);
    const saga = await waitForSaga(() => read(context, started.sagaId), settings.syncWaitMs);
    respond(res, saga, started.sagaId, started.replayed, input.createdStatus, context.correlationId);
  }

  return (router: Router): void => {
    router.post('/api/v1/users', async (req, res) => {
      const body = parseInput(createBody, req.body, 'body');
      const userId = newId();
      // The temporary password is kept in memory only (never in the saga request or any log).
      const { temporaryPassword, ...profile } = body;
      const request = { ...profile, email: profile.email.toLowerCase(), userId };
      await start(req, res, {
        routeTemplate: '/api/v1/users',
        keyRequired: true,
        body,
        sagaType: SAGA_TYPES.creation,
        targetUserId: userId,
        request,
        firstStep: 'reserve_user',
        firstPayload: { userId, email: request.email, firstName: request.firstName, lastName: request.lastName, role: request.role },
        createdStatus: 201,
        secret: temporaryPassword,
      });
    });

    router.patch('/api/v1/users/:userId/role', async (req, res) => {
      const { userId } = parseInput(userParams, req.params, 'params');
      const body = parseInput(roleBody, req.body, 'body');
      await start(req, res, {
        routeTemplate: '/api/v1/users/:userId/role',
        keyRequired: false,
        body: { userId, ...body },
        sagaType: SAGA_TYPES.roleChange,
        targetUserId: userId,
        request: { userId, role: body.role },
        firstStep: 'change_role',
        firstPayload: { userId, role: body.role },
        createdStatus: 200,
      });
    });

    router.post('/api/v1/users/:userId/deactivate', async (req, res) => {
      const { userId } = parseInput(userParams, req.params, 'params');
      await start(req, res, {
        routeTemplate: '/api/v1/users/:userId/deactivate',
        keyRequired: false,
        body: { userId },
        sagaType: SAGA_TYPES.deactivation,
        targetUserId: userId,
        request: { userId },
        firstStep: 'deactivate_user',
        firstPayload: { userId },
        createdStatus: 200,
      });
    });

    router.get('/api/v1/user-operations/:operationId', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'users:manage');
      const { operationId } = parseInput(pathParams({ operationId: uuidSchema }), req.params, 'params');
      const saga = await read(context, operationId);
      if (saga === null) throw new NotFoundError('operation', 'Operation not found.');
      sendData(res, 200, operationView(saga));
    });
  };
}
