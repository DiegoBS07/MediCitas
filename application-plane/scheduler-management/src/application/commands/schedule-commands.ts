import { ValidationError, newId } from '@medicitas/kernel';
import type { EventSink } from '@medicitas/messaging';
import type { Appointment } from '../../domain/entities/appointment.js';
import {
  blockNotFound,
  dateRangeTooLarge,
  notOwnProfessional,
  professionalInactive,
  professionalNotFound,
} from '../../domain/errors/scheduler-errors.js';
import { SCHEDULER_EVENTS, emitAvailabilityChanged, type AvailabilityChange } from '../../domain/events/scheduler-events.js';
import { normalizeWeeklySchedule, type WeeklyBlock } from '../../domain/services/weekly-schedule.js';
import type { CalendarBlock, ProfessionalReplica, SchedulerRepository } from '../ports/scheduler-ports.js';
import type { CommandResult } from './appointment-commands.js';

/** Who is editing: schedule:manage may target anyone; schedule:manage-own only their own profile. */
export interface ScheduleEditor {
  readonly subject: string;
  readonly canManageAll: boolean;
}

/** Loads the professional replica and applies the ownership rule (403) and the active rule (422). */
export async function editableProfessional(
  repository: SchedulerRepository,
  professionalId: string,
  editor: ScheduleEditor,
): Promise<ProfessionalReplica> {
  const professional = await repository.professional(professionalId);
  if (professional === null) throw professionalNotFound();
  if (!editor.canManageAll && professional.keycloakSubject !== editor.subject) throw notOwnProfessional();
  if (professional.status !== 'active') throw professionalInactive();
  return professional;
}

export interface WeeklyScheduleResult {
  readonly professionalId: string;
  readonly timezone: string;
  readonly scheduleVersion: number;
  readonly blocks: readonly WeeklyBlock[];
  readonly conflicts: readonly Appointment[];
}

/**
 * RF5 as ONE local transaction (no saga): anchor FOR UPDATE (waits for in-flight
 * bookings), replace the whole block set, bump schedule_version, and list the future appointments
 * that now fall outside working hours (they are kept and reported).
 */
export async function defineWeeklySchedule(
  repository: SchedulerRepository,
  events: EventSink,
  input: { readonly professionalId: string; readonly blocks: readonly WeeklyBlock[]; readonly editor: ScheduleEditor },
): Promise<CommandResult<WeeklyScheduleResult>> {
  const blocks = normalizeWeeklySchedule(input.blocks);
  await editableProfessional(repository, input.professionalId, input.editor);
  await repository.lockAnchors([input.professionalId], 'UPDATE');
  await repository.replaceWeeklyBlocks(input.professionalId, blocks);
  const scheduleVersion = await repository.bumpScheduleVersion(input.professionalId);
  const conflicts = await repository.futureOutsideWorkingHours(input.professionalId);
  const timezone = await repository.tenantTimezone();
  await events.emit({
    ...SCHEDULER_EVENTS.scheduleDefined,
    payload: {
      professionalId: input.professionalId,
      scheduleVersion,
      blocks: blocks.map((block) => ({ ...block })),
      conflictAppointmentIds: conflicts.map((appointment) => appointment.id),
    },
  });
  const change: AvailabilityChange = { professionalId: input.professionalId, dates: [], scheduleVersion, dateVersions: {} };
  await emitAvailabilityChanged(events, change);
  return { value: { professionalId: input.professionalId, timezone, scheduleVersion, blocks, conflicts }, changes: [change] };
}

const MAX_BLOCK_SPAN_MS = 90 * 24 * 60 * 60 * 1000;

/** RF6: a block never cancels booked appointments; they are returned as conflicts. */
export async function createCalendarBlock(
  repository: SchedulerRepository,
  events: EventSink,
  input: {
    readonly professionalId: string;
    readonly startAt: string;
    readonly endAt: string;
    readonly reason: CalendarBlock['reason'];
    readonly note: string | null;
    readonly editor: ScheduleEditor;
  },
): Promise<CommandResult<{ readonly block: CalendarBlock; readonly conflicts: readonly Appointment[] }>> {
  const span = Date.parse(input.endAt) - Date.parse(input.startAt);
  if (!(span > 0)) throw new ValidationError('Invalid block.', [{ path: 'body.endAt', message: 'endAt must be after startAt' }]);
  if (span > MAX_BLOCK_SPAN_MS) throw dateRangeTooLarge(90);
  await editableProfessional(repository, input.professionalId, input.editor);
  await repository.lockAnchors([input.professionalId], 'UPDATE');
  const block = await repository.insertCalendarBlock({
    id: newId(),
    professionalId: input.professionalId,
    startAt: input.startAt,
    endAt: input.endAt,
    reason: input.reason,
    note: input.note,
    createdBySubject: input.editor.subject,
  });
  const dates = await repository.localDatesSpanned(block.startAt, block.endAt);
  const dateVersions = await repository.bumpDateVersions(input.professionalId, dates);
  const conflicts = await repository.bookedOverlapping(input.professionalId, block.startAt, block.endAt);
  await events.emit({
    ...SCHEDULER_EVENTS.blockCreated,
    payload: {
      blockId: block.id,
      professionalId: block.professionalId,
      startAt: block.startAt.toISOString(),
      endAt: block.endAt.toISOString(),
      reason: block.reason,
      conflictAppointmentIds: conflicts.map((appointment) => appointment.id),
    },
  });
  const change: AvailabilityChange = { professionalId: input.professionalId, dates, scheduleVersion: null, dateVersions };
  await emitAvailabilityChanged(events, change);
  return { value: { block, conflicts }, changes: [change] };
}

/** RF6 removal (logical): availability is restored immediately through the version bump. */
export async function removeCalendarBlock(
  repository: SchedulerRepository,
  events: EventSink,
  input: { readonly professionalId: string; readonly blockId: string; readonly editor: ScheduleEditor },
): Promise<CommandResult<null>> {
  const professional = await repository.professional(input.professionalId);
  if (professional === null) throw professionalNotFound();
  if (!input.editor.canManageAll && professional.keycloakSubject !== input.editor.subject) throw notOwnProfessional();
  await repository.lockAnchors([input.professionalId], 'UPDATE');
  const block = await repository.findCalendarBlock(input.professionalId, input.blockId, { forUpdate: true });
  if (block === null) throw blockNotFound();
  if (block.status === 'removed') return { value: null, changes: [] };
  await repository.removeCalendarBlock(block.id, input.editor.subject);
  const dates = await repository.localDatesSpanned(block.startAt, block.endAt);
  const dateVersions = await repository.bumpDateVersions(input.professionalId, dates);
  await events.emit({
    ...SCHEDULER_EVENTS.blockRemoved,
    payload: {
      blockId: block.id,
      professionalId: block.professionalId,
      startAt: block.startAt.toISOString(),
      endAt: block.endAt.toISOString(),
      reason: block.reason,
      conflictAppointmentIds: [],
    },
  });
  const change: AvailabilityChange = { professionalId: input.professionalId, dates, scheduleVersion: null, dateVersions };
  await emitAvailabilityChanged(events, change);
  return { value: null, changes: [change] };
}
