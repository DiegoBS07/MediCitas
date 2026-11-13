import type { Router } from 'express';
import { z } from 'zod';
import { AuthorizationError, ValidationError, withTransaction } from '@medicitas/kernel';
import { hasPermission, requirePermission } from '@medicitas/identity';
import {
  contextOf,
  cursorSchema,
  decodeCursor,
  instantSchema,
  limitSchema,
  localDateSchema,
  parseInput,
  pathParams,
  sendData,
  tenantTransaction,
  toPage,
  uuidSchema,
} from '@medicitas/runtime';
import { PUBLIC_STATUSES, toAppointmentView } from '../../domain/entities/appointment.js';
import { dateRangeTooLarge } from '../../domain/errors/scheduler-errors.js';
import { daysBetween } from '../../application/queries/availability.js';
import { PgReadRepository } from '../../infrastructure/persistence/pg-read-repository.js';
import { PgSchedulerRepository } from '../../infrastructure/persistence/pg-scheduler-repository.js';
import { PREFIX, type SchedulerHttpDeps } from './support.js';

const historyQuery = z
  .object({
    status: z.enum(PUBLIC_STATUSES).optional(),
    from: localDateSchema.optional(),
    to: localDateSchema.optional(),
    limit: limitSchema,
    cursor: cursorSchema,
  })
  .strict();
const agendaQuery = z.object({ date: localDateSchema, professionalId: uuidSchema.optional() }).strict();
const countsQuery = z.object({ from: localDateSchema, to: localDateSchema, professionalId: uuidSchema.optional() }).strict();
const auditQuery = z
  .object({
    actorSubject: uuidSchema.optional(),
    patientId: uuidSchema.optional(),
    from: instantSchema.optional(),
    to: instantSchema.optional(),
    action: z.enum(['read', 'create', 'update']).optional(),
    resourceType: z.enum(['clinical_note', 'patient_contact']).optional(),
    limit: limitSchema,
    cursor: cursorSchema,
  })
  .strict();
const keysetCursor = z.tuple([z.string().min(1).max(64), uuidSchema]);

function checkRange(from: string, to: string, maxDays: number): void {
  if (to < from) throw new ValidationError('Invalid range.', [{ path: 'query.to', message: 'must not be before from' }]);
  if (daysBetween(from, to) > maxDays) throw dateRangeTooLarge(maxDays);
}

/** RF16, RF19, RF20, RF21: local queries, not broadcast events. */
export function readRoutes(deps: SchedulerHttpDeps) {
  return (router: Router): void => {
    router.get('/api/v1/patients/:patientId/appointments', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'patient-history:read');
      const { patientId } = parseInput(pathParams({ patientId: uuidSchema }), req.params, 'params');
      const query = parseInput(historyQuery, req.query, 'query');
      const after = decodeCursor(query.cursor, keysetCursor);
      // Unknown or foreign patient → empty list: the scheduler reveals nothing.
      const rows = await withTransaction(deps.pool, tenantTransaction(PREFIX, context, { readOnly: true }), (client) =>
        new PgReadRepository(client).patientHistory({
          patientId,
          statuses: query.status === undefined ? PUBLIC_STATUSES : [query.status],
          from: query.from ?? null,
          to: query.to ?? null,
          limit: query.limit + 1,
          after,
        }),
      );
      res.status(200).json(toPage(rows, query.limit, toAppointmentView, (row) => [row.startsAtExact, row.id]));
    });

    router.get('/api/v1/agenda', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'agenda:read', 'agenda:read-own');
      const query = parseInput(agendaQuery, req.query, 'query');
      const clinicWide = hasPermission(context, 'agenda:read');
      const data = await withTransaction(deps.pool, tenantTransaction(PREFIX, context, { readOnly: true }), async (client) => {
        let professionalId = query.professionalId ?? null;
        if (!clinicWide) {
          // agenda:read-own: forced to the caller's own professional profile.
          const own = await new PgSchedulerRepository(client).professionalBySubject(context.subject);
          if (own === null || (professionalId !== null && professionalId !== own.id)) {
            throw new AuthorizationError('A professional may only read their own agenda.');
          }
          professionalId = own.id;
        }
        const reads = new PgReadRepository(client);
        const { timezone } = await reads.todayAndHorizon();
        return { date: query.date, timezone, items: await reads.agenda(query.date, professionalId) };
      });
      sendData(res, 200, data);
    });

    router.get('/api/v1/reports/appointment-status-counts', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'reports:read');
      const query = parseInput(countsQuery, req.query, 'query');
      checkRange(query.from, query.to, 366);
      const data = await withTransaction(deps.pool, tenantTransaction(PREFIX, context, { readOnly: true }), async (client) => {
        const reads = new PgReadRepository(client);
        const counts = await reads.statusCounts(query.from, query.to, query.professionalId ?? null);
        const { timezone } = await reads.todayAndHorizon();
        const full = Object.fromEntries(PUBLIC_STATUSES.map((status) => [status, counts[status] ?? 0]));
        const total = Object.values(full).reduce((sum, value) => sum + value, 0);
        return { from: query.from, to: query.to, timezone, counts: full, total };
      });
      sendData(res, 200, data);
    });

    router.get('/api/v1/audit-log', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'audit:read');
      const query = parseInput(auditQuery, req.query, 'query');
      const after = decodeCursor(query.cursor, keysetCursor);
      const rows = await withTransaction(deps.pool, tenantTransaction(PREFIX, context, { readOnly: true }), (client) =>
        new PgReadRepository(client).auditLog({
          actorSubject: query.actorSubject ?? null,
          patientId: query.patientId ?? null,
          from: query.from ?? null,
          to: query.to ?? null,
          action: query.action ?? null,
          resourceType: query.resourceType ?? null,
          limit: query.limit + 1,
          after,
        }),
      );
      res.status(200).json(
        toPage(
          rows,
          query.limit,
          ({ occurredAtExact: _exact, ...entry }) => entry,
          (row) => [row.occurredAtExact, row.auditId],
        ),
      );
    });
  };
}
