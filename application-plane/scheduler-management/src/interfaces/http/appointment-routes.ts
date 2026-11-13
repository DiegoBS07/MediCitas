import type { Router } from 'express';
import { z } from 'zod';
import { AuthorizationError, withTransaction } from '@medicitas/kernel';
import { hasPermission, requirePermission, requireTenant } from '@medicitas/identity';
import { contextOf, instantSchema, parseInput, pathParams, requestEvents, sendData, tenantTransaction, uuidSchema } from '@medicitas/runtime';
import { OUTCOMES, isPublic, toAppointmentView } from '../../domain/entities/appointment.js';
import { appointmentNotFound } from '../../domain/errors/scheduler-errors.js';
import { cancelAppointment, recordOutcome, rescheduleAppointment } from '../../application/commands/appointment-commands.js';
import { readClinicalNote, writeClinicalNote, type NoteCaller } from '../../application/commands/clinical-notes.js';
import { PgSchedulerRepository } from '../../infrastructure/persistence/pg-scheduler-repository.js';
import { PREFIX, SERVICE, mutate, type SchedulerHttpDeps } from './support.js';

const appointmentParams = pathParams({ appointmentId: uuidSchema });
const rescheduleBody = z.object({ startAt: instantSchema, professionalId: uuidSchema.optional() }).strict();
const cancelBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const outcomeBody = z.object({ outcome: z.enum(OUTCOMES) }).strict();
const noteBody = z.object({ content: z.string().min(1).max(20_000).refine((value) => value.trim().length > 0, 'must not be blank') }).strict();

const deniedNote = (): AuthorizationError => new AuthorizationError('Only the professional of the appointment may access its clinical note.');

/** RF10–RF13 and RF15 (api-contracts §3.7). Each mutation is a single local ACID transaction (ADR-0007). */
export function appointmentRoutes(deps: SchedulerHttpDeps) {
  return (router: Router): void => {
    router.get('/api/v1/appointments/:appointmentId', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'appointments:read');
      const { appointmentId } = parseInput(appointmentParams, req.params, 'params');
      const appointment = await withTransaction(deps.pool, tenantTransaction(PREFIX, context, { readOnly: true }), (client) =>
        new PgSchedulerRepository(client).findAppointment(appointmentId),
      );
      if (appointment === null || !isPublic(appointment)) throw appointmentNotFound();
      sendData(res, 200, toAppointmentView(appointment));
    });

    router.post('/api/v1/appointments/:appointmentId/reschedule', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'appointments:book');
      const { appointmentId } = parseInput(appointmentParams, req.params, 'params');
      const body = parseInput(rescheduleBody, req.body, 'body');
      await mutate(deps, req, res, '/api/v1/appointments/:appointmentId/reschedule', { appointmentId, ...body }, async (client) => {
        const result = await rescheduleAppointment(new PgSchedulerRepository(client), requestEvents(client, SERVICE, context), {
          appointmentId,
          startAt: body.startAt,
          ...(body.professionalId === undefined ? {} : { professionalId: body.professionalId }),
          actorSubject: context.subject,
        });
        return {
          response: {
            status: 200,
            body: { data: { previous: toAppointmentView(result.value.previous), current: toAppointmentView(result.value.current) } },
          },
          changes: result.changes,
        };
      });
    });

    router.post('/api/v1/appointments/:appointmentId/cancel', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'appointments:book');
      const { appointmentId } = parseInput(appointmentParams, req.params, 'params');
      const body = parseInput(cancelBody, req.body, 'body');
      await mutate(deps, req, res, '/api/v1/appointments/:appointmentId/cancel', { appointmentId, ...body }, async (client) => {
        const result = await cancelAppointment(new PgSchedulerRepository(client), requestEvents(client, SERVICE, context), {
          appointmentId,
          reason: body.reason,
          actorSubject: context.subject,
        });
        return { response: { status: 200, body: { data: toAppointmentView(result.value) } }, changes: result.changes };
      });
    });

    router.post('/api/v1/appointments/:appointmentId/outcome', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'appointments:outcome');
      const { appointmentId } = parseInput(appointmentParams, req.params, 'params');
      const body = parseInput(outcomeBody, req.body, 'body');
      await mutate(deps, req, res, '/api/v1/appointments/:appointmentId/outcome', { appointmentId, ...body }, async (client) => {
        const appointment = await recordOutcome(new PgSchedulerRepository(client), requestEvents(client, SERVICE, context), {
          appointmentId,
          outcome: body.outcome,
          actorSubject: context.subject,
        });
        return { response: { status: 200, body: { data: toAppointmentView(appointment) } }, changes: [] };
      });
    });

    /** RF15 + RF18: denied attempts are audited and committed BEFORE answering 403. */
    const noteCaller = (res: Parameters<typeof contextOf>[0]): NoteCaller => {
      const context = contextOf(res);
      requireTenant(context);
      return {
        subject: context.subject,
        role: context.role,
        mayUseNotes: hasPermission(context, 'clinical-notes:own'),
        correlationId: context.correlationId,
      };
    };

    router.post('/api/v1/appointments/:appointmentId/clinical-note', async (req, res) => {
      const caller = noteCaller(res);
      const context = contextOf(res);
      const { appointmentId } = parseInput(appointmentParams, req.params, 'params');
      const body = caller.mayUseNotes ? parseInput(noteBody, req.body, 'body') : { content: '' };
      const outcome = await withTransaction(deps.pool, tenantTransaction(PREFIX, context), (client) =>
        writeClinicalNote(new PgSchedulerRepository(client), requestEvents(client, SERVICE, context), {
          appointmentId,
          content: body.content,
          caller,
        }),
      );
      if (outcome.kind === 'denied') throw deniedNote();
      sendData(res, 201, outcome.value);
    });

    router.get('/api/v1/appointments/:appointmentId/clinical-note', async (req, res) => {
      const caller = noteCaller(res);
      const context = contextOf(res);
      const { appointmentId } = parseInput(appointmentParams, req.params, 'params');
      const outcome = await withTransaction(deps.pool, tenantTransaction(PREFIX, context), (client) =>
        readClinicalNote(new PgSchedulerRepository(client), { appointmentId, caller }),
      );
      if (outcome.kind === 'denied') throw deniedNote();
      sendData(res, 200, outcome.value);
    });
  };
}
