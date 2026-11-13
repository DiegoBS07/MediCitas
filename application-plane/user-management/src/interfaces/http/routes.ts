import type { Router } from 'express';
import { z } from 'zod';
import { newId, withTransaction, type DatabasePool } from '@medicitas/kernel';
import { requirePermission, type TenantContext } from '@medicitas/identity';
import {
  contextOf,
  cursorSchema,
  decodeCursor,
  idempotencyKeyOf,
  limitSchema,
  parseInput,
  pathParams,
  requestEvents,
  requestHash,
  runIdempotent,
  sendData,
  sendOutcome,
  tenantTransaction,
  toPage,
  uuidSchema,
} from '@medicitas/runtime';
import { CLINIC_ROLES, USER_STATUSES } from '../../domain/entities/user.js';
import { IDENTIFICATION_TYPES, PATIENT_STATUSES } from '../../domain/entities/patient.js';
import { userNotFound } from '../../domain/errors/user-errors.js';
import { readPatient, registerPatient, updatePatient } from '../../application/commands/patient-commands.js';
import { toPatientSummary, toPatientView, toUserView } from '../../application/queries/views.js';
import { PgPatientRepository, PgUserRepository } from '../../infrastructure/persistence/pg-repositories.js';

const SERVICE = 'user-management';
const PREFIX = 'um';

const userListQuery = z
  .object({
    role: z.enum(CLINIC_ROLES).optional(),
    status: z.enum(USER_STATUSES).optional(),
    q: z.string().trim().min(2).max(80).optional(),
    limit: limitSchema,
    cursor: cursorSchema,
  })
  .strict();
const userCursor = z.tuple([z.string().max(200), z.string().max(200), uuidSchema]);

const name = z.string().trim().min(1).max(80);
const contactBody = z
  .object({
    email: z.email().max(254).nullable().optional(),
    phone: z.string().regex(/^\+?[0-9 ()-]{7,20}$/, 'invalid phone').nullable().optional(),
    address: z.string().trim().max(300).nullable().optional(),
  })
  .strict();
const today = (): string => new Date().toISOString().slice(0, 10);
const birthDate = z.iso.date().refine((value) => value >= '1900-01-01' && value <= today(), 'must be between 1900-01-01 and today');

const createPatientBody = z
  .object({
    identificationType: z.enum(IDENTIFICATION_TYPES),
    identificationNumber: z.string().regex(/^[A-Za-z0-9-]{3,30}$/, 'invalid identification number'),
    firstName: name,
    lastName: name,
    birthDate,
    contact: contactBody.optional(),
  })
  .strict();
const patchPatientBody = z
  .object({
    firstName: name.optional(),
    lastName: name.optional(),
    birthDate: birthDate.optional(),
    contact: contactBody.optional(),
    status: z.enum(PATIENT_STATUSES).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'at least one field is required');
const patientListQuery = z
  .object({ q: z.string().trim().min(2).max(80).optional(), limit: limitSchema, cursor: cursorSchema })
  .strict();
const patientCursor = z.tuple([z.string().max(200), uuidSchema]);

const auditActor = (context: TenantContext) => ({ subject: context.subject, role: context.role });

/** RF2 reads (users:manage) and RF14 patients (patients:read / patients:write). */
export function userManagementRoutes(pool: DatabasePool) {
  return (router: Router): void => {
    router.get('/api/v1/users', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'users:manage');
      const query = parseInput(userListQuery, req.query, 'query');
      const after = decodeCursor(query.cursor, userCursor);
      const rows = await withTransaction(pool, tenantTransaction(PREFIX, context, { readOnly: true }), (client) =>
        new PgUserRepository(client).list({
          role: query.role ?? null,
          status: query.status ?? null,
          search: query.q ?? null,
          limit: query.limit + 1,
          after,
        }),
      );
      res.status(200).json(toPage(rows, query.limit, toUserView, (user) => [user.lastName, user.firstName, user.id]));
    });

    router.get('/api/v1/users/:userId', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'users:manage');
      const { userId } = parseInput(pathParams({ userId: uuidSchema }), req.params, 'params');
      const user = await withTransaction(pool, tenantTransaction(PREFIX, context, { readOnly: true }), (client) =>
        new PgUserRepository(client).findById(userId),
      );
      if (user === null) throw userNotFound();
      sendData(res, 200, toUserView(user));
    });

    router.post('/api/v1/patients', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'patients:write');
      const body = parseInput(createPatientBody, req.body, 'body');
      const key = idempotencyKeyOf(req, false);
      const outcome = await withTransaction(pool, tenantTransaction(PREFIX, context), (client) =>
        runIdempotent(
          client,
          { tenantId: context.tenantId, method: 'POST', routeTemplate: '/api/v1/patients', key, requestHash: requestHash(body) },
          async () => {
            const patient = await registerPatient(new PgPatientRepository(client), requestEvents(client, SERVICE, context), {
              patientId: newId(),
              data: { ...body, contact: body.contact ?? {} },
              actor: auditActor(context),
            });
            return { status: 201, body: { data: toPatientView(patient) } };
          },
        ),
      );
      const created = outcome.response.body as { data: { patientId: string } };
      sendOutcome(res, outcome, { Location: `/api/v1/patients/${created.data.patientId}` });
    });

    router.get('/api/v1/patients', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'patients:read');
      const query = parseInput(patientListQuery, req.query, 'query');
      const after = decodeCursor(query.cursor, patientCursor);
      const rows = await withTransaction(pool, tenantTransaction(PREFIX, context, { readOnly: true }), (client) =>
        new PgPatientRepository(client).list({ search: query.q ?? null, limit: query.limit + 1, after }),
      );
      res.status(200).json(toPage(rows, query.limit, toPatientSummary, (patient) => [patient.lastName.toLowerCase(), patient.id]));
    });

    router.get('/api/v1/patients/:patientId', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'patients:read');
      const { patientId } = parseInput(pathParams({ patientId: uuidSchema }), req.params, 'params');
      const patient = await withTransaction(pool, tenantTransaction(PREFIX, context), (client) =>
        readPatient(new PgPatientRepository(client), requestEvents(client, SERVICE, context), {
          patientId,
          actor: auditActor(context),
        }),
      );
      sendData(res, 200, toPatientView(patient));
    });

    router.patch('/api/v1/patients/:patientId', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'patients:write');
      const { patientId } = parseInput(pathParams({ patientId: uuidSchema }), req.params, 'params');
      const patch = parseInput(patchPatientBody, req.body, 'body');
      const patient = await withTransaction(pool, tenantTransaction(PREFIX, context), (client) =>
        updatePatient(new PgPatientRepository(client), requestEvents(client, SERVICE, context), {
          patientId,
          patch,
          actor: auditActor(context),
        }),
      );
      sendData(res, 200, toPatientView(patient));
    });
  };
}
