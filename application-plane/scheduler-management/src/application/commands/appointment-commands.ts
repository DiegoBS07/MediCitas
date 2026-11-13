import { newId } from '@medicitas/kernel';
import type { EventSink } from '@medicitas/messaging';
import { assertBooked, isPublic, type Appointment, type Outcome } from '../../domain/entities/appointment.js';
import {
  appointmentNotFound,
  beyondHorizon,
  professionalNotFound,
  serviceNotFound,
  slotInPast,
} from '../../domain/errors/scheduler-errors.js';
import { BusinessRuleError } from '@medicitas/kernel';
import { SCHEDULER_EVENTS, emitAvailabilityChanged, type AvailabilityChange } from '../../domain/events/scheduler-events.js';
import type { SchedulerRepository } from '../ports/scheduler-ports.js';

export interface CommandResult<T> {
  readonly value: T;
  /** Availability changes to invalidate in the cache after COMMIT. */
  readonly changes: readonly AvailabilityChange[];
}

async function visible(repository: SchedulerRepository, appointmentId: string): Promise<Appointment> {
  const appointment = await repository.findAppointment(appointmentId);
  if (appointment === null || !isPublic(appointment)) throw appointmentNotFound();
  return appointment;
}

/** Bumps the date versions of several professionals in the global lock order (professional, date). */
async function bumpAll(
  repository: SchedulerRepository,
  affected: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<readonly AvailabilityChange[]> {
  const changes: AvailabilityChange[] = [];
  for (const professionalId of [...affected.keys()].sort()) {
    const dates = [...(affected.get(professionalId) ?? [])].sort();
    const dateVersions = await repository.bumpDateVersions(professionalId, dates);
    changes.push({ professionalId, dates, scheduleVersion: null, dateVersions });
  }
  return changes;
}

/**
 * RF10 in ONE READ COMMITTED transaction: anchors → versions → appointment row →
 * UPDATE old to `rescheduled` (frees the slot) → INSERT the new `booked` row. Any failure rolls back
 * everything, so the original stays booked; there is never a state with two (or zero) occupied slots.
 */
export async function rescheduleAppointment(
  repository: SchedulerRepository,
  events: EventSink,
  input: { readonly appointmentId: string; readonly startAt: string; readonly professionalId?: string; readonly actorSubject: string },
): Promise<CommandResult<{ readonly previous: Appointment; readonly current: Appointment }>> {
  const original = await visible(repository, input.appointmentId);
  const targetProfessional = input.professionalId ?? original.professionalId;
  const anchors = await repository.lockAnchors([original.professionalId, targetProfessional], 'SHARE');
  if (!anchors.includes(targetProfessional)) throw professionalNotFound();
  const service = await repository.service(original.serviceId);
  if (service === null) throw serviceNotFound();
  const slot = await repository.slotContext(input.startAt, service.durationMinutes);
  if (slot.inPast) throw slotInPast();
  if (slot.beyondHorizon) throw beyondHorizon();

  const oldDate = await repository.localDateOf(original.startAt);
  const affected = new Map<string, Set<string>>();
  affected.set(original.professionalId, new Set([oldDate]));
  affected.set(targetProfessional, new Set([...(affected.get(targetProfessional) ?? []), slot.localDate]));
  const changes = await bumpAll(repository, affected);

  const locked = await repository.findAppointment(original.id, { forUpdate: true });
  if (locked === null) throw appointmentNotFound();
  assertBooked(locked, 'reschedule');
  await repository.markRescheduled(locked.id);
  const current = await repository.insertAppointment({
    id: newId(),
    patientId: locked.patientId,
    professionalId: targetProfessional,
    serviceId: locked.serviceId,
    startAt: slot.startAt,
    endAt: slot.endAt,
    status: 'booked',
    holdTtlSeconds: null,
    sagaId: null,
    rescheduledFromId: locked.id,
    bookedBySubject: input.actorSubject,
  });
  const previous = await visible(repository, locked.id);
  await events.emit({
    ...SCHEDULER_EVENTS.appointmentRescheduled,
    payload: {
      previousAppointmentId: previous.id,
      appointmentId: current.id,
      professionalId: current.professionalId,
      startAt: current.startAt.toISOString(),
      endAt: current.endAt.toISOString(),
      aggregateVersion: current.version,
    },
  });
  for (const change of changes) await emitAvailabilityChanged(events, change);
  return { value: { previous, current }, changes };
}

/** RF11: booked → cancelled in one transaction that frees the slot immediately (I7). */
export async function cancelAppointment(
  repository: SchedulerRepository,
  events: EventSink,
  input: { readonly appointmentId: string; readonly reason: string; readonly actorSubject: string },
): Promise<CommandResult<Appointment>> {
  const original = await visible(repository, input.appointmentId);
  const date = await repository.localDateOf(original.startAt);
  const changes = await bumpAll(repository, new Map([[original.professionalId, new Set([date])]]));
  const locked = await repository.findAppointment(original.id, { forUpdate: true });
  if (locked === null) throw appointmentNotFound();
  assertBooked(locked, 'cancel');
  const cancelled = await repository.cancel(locked.id, input.reason, input.actorSubject);
  await events.emit({
    ...SCHEDULER_EVENTS.appointmentCancelled,
    payload: { appointmentId: cancelled.id, cancelledBy: input.actorSubject, reasonProvided: true, aggregateVersion: cancelled.version },
  });
  for (const change of changes) await emitAvailabilityChanged(events, change);
  return { value: cancelled, changes };
}

/** RF12: outcome only after the start, checked with the DATABASE clock (the trigger re-checks). */
export async function recordOutcome(
  repository: SchedulerRepository,
  events: EventSink,
  input: { readonly appointmentId: string; readonly outcome: Outcome; readonly actorSubject: string },
): Promise<Appointment> {
  await visible(repository, input.appointmentId);
  const locked = await repository.findAppointment(input.appointmentId, { forUpdate: true });
  if (locked === null) throw appointmentNotFound();
  assertBooked(locked, 'record the outcome of');
  if ((await repository.dbNow()) < locked.startAt) {
    throw new BusinessRuleError('OUTCOME_BEFORE_START', 'An outcome can only be recorded after the start time.');
  }
  const updated = await repository.recordOutcome(locked.id, input.outcome, input.actorSubject);
  await events.emit({
    ...SCHEDULER_EVENTS.outcomeRecorded,
    payload: { appointmentId: updated.id, outcome: input.outcome, recordedBy: input.actorSubject, aggregateVersion: updated.version },
  });
  return updated;
}
