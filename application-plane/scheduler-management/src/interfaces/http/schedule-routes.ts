import type { Router } from 'express';
import { z } from 'zod';
import { ValidationError, withTransaction } from '@medicitas/kernel';
import { hasPermission, requirePermission, requireTenant } from '@medicitas/identity';
import { contextOf, instantSchema, localDateSchema, localTimeSchema, parseInput, pathParams, requestEvents, sendData, tenantTransaction, uuidSchema } from '@medicitas/runtime';
import { toAppointmentSummary } from '../../domain/entities/appointment.js';
import { dateRangeTooLarge, professionalNotFound, serviceNotFound } from '../../domain/errors/scheduler-errors.js';
import { createCalendarBlock, defineWeeklySchedule, removeCalendarBlock } from '../../application/commands/schedule-commands.js';
import { assertWithinHorizon, availabilityFor, datesBetween, daysBetween, futureSlots } from '../../application/queries/availability.js';
import type { CacheStatus } from '../../infrastructure/cache/availability-cache.js';
import { PgReadRepository } from '../../infrastructure/persistence/pg-read-repository.js';
import { PgSchedulerRepository } from '../../infrastructure/persistence/pg-scheduler-repository.js';
import { PREFIX, SERVICE, mutate, type SchedulerHttpDeps } from './support.js';

const professionalParams = pathParams({ professionalId: uuidSchema });
const blockParams = pathParams({ professionalId: uuidSchema, blockId: uuidSchema });
const weeklyBody = z
  .object({
    blocks: z
      .array(z.object({ dayOfWeek: z.number().int().min(1).max(7), startTime: localTimeSchema, endTime: localTimeSchema }).strict())
      .max(50),
  })
  .strict();
const blockBody = z
  .object({
    startAt: instantSchema,
    endAt: instantSchema,
    reason: z.enum(['vacation', 'leave', 'other']),
    note: z.string().trim().max(200).optional(),
  })
  .strict();
const rangeQuery = z.object({ from: localDateSchema.optional(), to: localDateSchema.optional() }).strict();
const conflictsQuery = z.object({ professionalId: uuidSchema.optional(), from: localDateSchema.optional(), to: localDateSchema.optional() }).strict();
const availabilityQuery = z.object({ professionalId: uuidSchema, serviceId: uuidSchema, date: localDateSchema }).strict();
const searchQuery = z.object({ serviceId: uuidSchema, from: localDateSchema, to: localDateSchema }).strict();

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function checkRange(from: string, to: string, maxDays: number): void {
  if (to < from) throw new ValidationError('Invalid range.', [{ path: 'query.to', message: 'must not be before from' }]);
  if (daysBetween(from, to) > maxDays) throw dateRangeTooLarge(maxDays);
}

function combine(statuses: readonly CacheStatus[]): CacheStatus {
  if (statuses.includes('BYPASS')) return 'BYPASS';
  return statuses.length > 0 && statuses.every((status) => status === 'HIT') ? 'HIT' : 'MISS';
}

/** RF5, RF6, RF7, RF8. */
export function scheduleRoutes(deps: SchedulerHttpDeps) {
  return (router: Router): void => {
    router.put('/api/v1/professionals/:professionalId/weekly-schedule', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'schedule:manage', 'schedule:manage-own');
      const { professionalId } = parseInput(professionalParams, req.params, 'params');
      const body = parseInput(weeklyBody, req.body, 'body');
      await mutate(deps, req, res, '/api/v1/professionals/:professionalId/weekly-schedule', { professionalId, ...body }, async (client) => {
        const result = await defineWeeklySchedule(new PgSchedulerRepository(client), requestEvents(client, SERVICE, context), {
          professionalId,
          blocks: body.blocks,
          editor: { subject: context.subject, canManageAll: hasPermission(context, 'schedule:manage') },
        });
        const value = result.value;
        return {
          response: {
            status: 200,
            body: {
              data: {
                professionalId: value.professionalId,
                timezone: value.timezone,
                scheduleVersion: value.scheduleVersion,
                blocks: value.blocks,
                conflicts: value.conflicts.map(toAppointmentSummary),
              },
            },
          },
          changes: result.changes,
        };
      });
    });

    router.get('/api/v1/professionals/:professionalId/weekly-schedule', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'schedule:read');
      const { professionalId } = parseInput(professionalParams, req.params, 'params');
      const data = await withTransaction(deps.pool, tenantTransaction(PREFIX, context, { readOnly: true, isolation: 'REPEATABLE READ' }), async (client) => {
        const repository = new PgSchedulerRepository(client);
        if ((await repository.professional(professionalId)) === null) throw professionalNotFound();
        return {
          professionalId,
          timezone: await repository.tenantTimezone(),
          scheduleVersion: await repository.scheduleVersion(professionalId),
          blocks: await repository.weeklyBlocks(professionalId),
        };
      });
      sendData(res, 200, data);
    });

    router.post('/api/v1/professionals/:professionalId/calendar-blocks', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'schedule:manage', 'schedule:manage-own');
      const { professionalId } = parseInput(professionalParams, req.params, 'params');
      const body = parseInput(blockBody, req.body, 'body');
      await mutate(deps, req, res, '/api/v1/professionals/:professionalId/calendar-blocks', { professionalId, ...body }, async (client) => {
        const result = await createCalendarBlock(new PgSchedulerRepository(client), requestEvents(client, SERVICE, context), {
          professionalId,
          startAt: body.startAt,
          endAt: body.endAt,
          reason: body.reason,
          note: body.note ?? null,
          editor: { subject: context.subject, canManageAll: hasPermission(context, 'schedule:manage') },
        });
        const { block, conflicts } = result.value;
        return {
          response: {
            status: 201,
            body: {
              data: {
                blockId: block.id,
                professionalId: block.professionalId,
                startAt: block.startAt.toISOString(),
                endAt: block.endAt.toISOString(),
                reason: block.reason,
                note: block.note,
                status: block.status,
                conflicts: conflicts.map(toAppointmentSummary),
              },
            },
          },
          changes: result.changes,
        };
      });
    });

    router.get('/api/v1/professionals/:professionalId/calendar-blocks', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'schedule:read');
      const { professionalId } = parseInput(professionalParams, req.params, 'params');
      const query = parseInput(rangeQuery, req.query, 'query');
      const blocks = await withTransaction(deps.pool, tenantTransaction(PREFIX, context, { readOnly: true }), async (client) => {
        const repository = new PgSchedulerRepository(client);
        if ((await repository.professional(professionalId)) === null) throw professionalNotFound();
        const { today } = await new PgReadRepository(client).todayAndHorizon();
        const from = query.from ?? today;
        const to = query.to ?? addDays(from, 90);
        checkRange(from, to, 366);
        return repository.listCalendarBlocks(professionalId, from, to);
      });
      sendData(
        res,
        200,
        blocks.map((block) => ({
          blockId: block.id,
          professionalId: block.professionalId,
          startAt: block.startAt.toISOString(),
          endAt: block.endAt.toISOString(),
          reason: block.reason,
          note: block.note,
          status: block.status,
          createdAt: block.createdAt.toISOString(),
        })),
      );
    });

    router.delete('/api/v1/professionals/:professionalId/calendar-blocks/:blockId', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'schedule:manage', 'schedule:manage-own');
      const params = parseInput(blockParams, req.params, 'params');
      await mutate(deps, req, res, '/api/v1/professionals/:professionalId/calendar-blocks/:blockId', params, async (client) => {
        const result = await removeCalendarBlock(new PgSchedulerRepository(client), requestEvents(client, SERVICE, context), {
          ...params,
          editor: { subject: context.subject, canManageAll: hasPermission(context, 'schedule:manage') },
        });
        return { response: { status: 204, body: {} }, changes: result.changes };
      });
    });

    router.get('/api/v1/schedule-conflicts', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'schedule:read');
      const query = parseInput(conflictsQuery, req.query, 'query');
      const rows = await withTransaction(deps.pool, tenantTransaction(PREFIX, context, { readOnly: true }), async (client) => {
        const { today } = await new PgReadRepository(client).todayAndHorizon();
        const from = query.from ?? today;
        const to = query.to ?? addDays(from, 90);
        checkRange(from, to, 366);
        return new PgSchedulerRepository(client).conflicts({ professionalId: query.professionalId ?? null, from, to });
      });
      sendData(
        res,
        200,
        rows.map((row) => ({
          appointment: toAppointmentSummary(row.appointment),
          reasons: [...(row.blocked ? ['CALENDAR_BLOCK'] : []), ...(row.outsideWorkingHours ? ['OUTSIDE_WORKING_HOURS'] : [])],
        })),
      );
    });

    router.get('/api/v1/availability', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'availability:read');
      const query = parseInput(availabilityQuery, req.query, 'query');
      const tenantId = requireTenant(context);
      const result = await withTransaction(deps.pool, tenantTransaction(PREFIX, context, { readOnly: true, isolation: 'REPEATABLE READ' }), (client) =>
        availabilityFor(new PgReadRepository(client), deps.cache, { tenantId, ...query }),
      );
      res.setHeader('X-Cache', result.cache);
      sendData(res, 200, {
        professionalId: query.professionalId,
        serviceId: query.serviceId,
        date: query.date,
        timezone: result.entry.timezone,
        durationMinutes: result.entry.durationMinutes,
        stepMinutes: result.entry.stepMinutes,
        version: result.entry.version,
        generatedAt: result.entry.generatedAt,
        slots: futureSlots(result),
      });
    });

    router.get('/api/v1/availability/search', async (req, res) => {
      const context = contextOf(res);
      requirePermission(context, 'availability:read');
      const query = parseInput(searchQuery, req.query, 'query');
      const tenantId = requireTenant(context);
      checkRange(query.from, query.to, 14);
      const data = await withTransaction(deps.pool, tenantTransaction(PREFIX, context, { readOnly: true, isolation: 'REPEATABLE READ' }), async (client) => {
        const reads = new PgReadRepository(client);
        const scheduler = new PgSchedulerRepository(client);
        const service = await scheduler.service(query.serviceId);
        if (service === null) throw serviceNotFound();
        const horizon = await reads.todayAndHorizon();
        assertWithinHorizon(horizon, query.from, 'query.from');
        assertWithinHorizon(horizon, query.to, 'query.to');
        const statuses: CacheStatus[] = [];
        const professionals = [];
        let durationMinutes = service.durationMinutes;
        for (const professional of await reads.activeProfessionalsOffering(query.serviceId)) {
          const days = [];
          for (const date of datesBetween(query.from, query.to)) {
            const result = await availabilityFor(reads, deps.cache, { tenantId, professionalId: professional.id, serviceId: query.serviceId, date });
            statuses.push(result.cache);
            durationMinutes = result.entry.durationMinutes;
            const slots = futureSlots(result);
            if (slots.length > 0) days.push({ date, slots });
          }
          if (days.length > 0) professionals.push({ professionalId: professional.id, displayName: professional.displayName, days });
        }
        return { cache: combine(statuses), body: { serviceId: query.serviceId, timezone: horizon.timezone, durationMinutes, professionals } };
      });
      res.setHeader('X-Cache', data.cache);
      sendData(res, 200, data.body);
    });
  };
}
