import type { EventSink } from '@medicitas/messaging';
import type { Appointment } from '../../domain/entities/appointment.js';
import {
  appointmentNotFound,
  beyondHorizon,
  holdExpired,
  professionalNotFound,
  serviceNotFound,
  slotInPast,
} from '../../domain/errors/scheduler-errors.js';
import {
  SCHEDULER_EVENTS,
  appointmentCreatedPayload,
  emitAvailabilityChanged,
  type AvailabilityChange,
} from '../../domain/events/scheduler-events.js';
import type { SchedulerRepository } from '../ports/scheduler-ports.js';

export interface HoldSlotInput {
  readonly appointmentId: string;
  readonly patientId: string;
  readonly professionalId: string;
  readonly serviceId: string;
  readonly startAt: string;
  readonly sagaId: string | null;
  readonly actorSubject: string;
}

export type SlotHeld = {
  readonly appointmentId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly durationMinutes: number;
  readonly serviceVersion: number;
  readonly holdExpiresAt: string | null;
};

function heldResult(appointment: Appointment, serviceVersion: number): SlotHeld {
  return {
    appointmentId: appointment.id,
    startAt: appointment.startAt.toISOString(),
    endAt: appointment.endAt.toISOString(),
    durationMinutes: appointment.durationMinutes,
    serviceVersion,
    holdExpiresAt: appointment.holdExpiresAt === null ? null : appointment.holdExpiresAt.toISOString(),
  };
}

/**
 * HoldSlotCommand (RF9, ADR-0006/0007): READ COMMITTED; anchor FOR SHARE → bump the date version
 * (serialization point of competing holds) → INSERT `held`. The interval comes from the replica
 * duration (I4). The exclusion constraints decide I1/I2: exactly one competing hold wins.
 */
export async function holdSlot(repository: SchedulerRepository, events: EventSink, input: HoldSlotInput): Promise<SlotHeld> {
  const existing = await repository.findAppointment(input.appointmentId);
  if (existing !== null) {
    if (existing.status !== 'held' && existing.status !== 'booked') throw holdExpired();
    const service = await repository.service(existing.serviceId);
    return heldResult(existing, service?.version ?? 0);
  }
  const anchors = await repository.lockAnchors([input.professionalId], 'SHARE');
  if (anchors.length === 0) throw professionalNotFound();
  const service = await repository.service(input.serviceId);
  if (service === null) throw serviceNotFound();
  const slot = await repository.slotContext(input.startAt, service.durationMinutes);
  if (slot.inPast) throw slotInPast();
  if (slot.beyondHorizon) throw beyondHorizon();

  const dateVersions = await repository.bumpDateVersions(input.professionalId, [slot.localDate]);
  const appointment = await repository.insertAppointment({
    id: input.appointmentId,
    patientId: input.patientId,
    professionalId: input.professionalId,
    serviceId: input.serviceId,
    startAt: slot.startAt,
    endAt: slot.endAt,
    status: 'held',
    holdTtlSeconds: slot.holdTtlSeconds,
    sagaId: input.sagaId,
    rescheduledFromId: null,
    bookedBySubject: input.actorSubject,
  });
  await emitAvailabilityChanged(events, { professionalId: input.professionalId, dates: [slot.localDate], scheduleVersion: null, dateVersions });
  return heldResult(appointment, service.version);
}

/** ConfirmAppointmentCommand: held → booked (only before the hold expires); emits AppointmentCreated. */
export async function confirmAppointment(
  repository: SchedulerRepository,
  events: EventSink,
  input: { readonly appointmentId: string },
): Promise<Appointment> {
  const current = await repository.findAppointment(input.appointmentId);
  if (current === null) throw appointmentNotFound();
  const date = await repository.localDateOf(current.startAt);
  const dateVersions = await repository.bumpDateVersions(current.professionalId, [date]);
  const locked = await repository.findAppointment(input.appointmentId, { forUpdate: true });
  if (locked === null) throw appointmentNotFound();
  if (locked.status === 'booked') return locked;
  const now = await repository.dbNow();
  if (locked.status !== 'held' || locked.holdExpiresAt === null || locked.holdExpiresAt <= now) throw holdExpired();
  const booked = await repository.confirmHold(locked.id);
  await events.emit({ ...SCHEDULER_EVENTS.appointmentCreated, payload: appointmentCreatedPayload(booked) });
  await emitAvailabilityChanged(events, { professionalId: booked.professionalId, dates: [date], scheduleVersion: null, dateVersions });
  return booked;
}

/** ReleaseSlotCommand (compensation) and hold expiry: held → released; idempotent no-op otherwise. */
export async function releaseSlot(
  repository: SchedulerRepository,
  events: EventSink,
  input: { readonly appointmentId: string; readonly reasonCode: string },
): Promise<{ readonly appointmentId: string; readonly released: boolean; readonly change: AvailabilityChange | null }> {
  const current = await repository.findAppointment(input.appointmentId);
  if (current === null || current.status !== 'held') return { appointmentId: input.appointmentId, released: false, change: null };
  const date = await repository.localDateOf(current.startAt);
  const dateVersions = await repository.bumpDateVersions(current.professionalId, [date]);
  const locked = await repository.findAppointment(input.appointmentId, { forUpdate: true });
  if (locked === null || locked.status !== 'held') return { appointmentId: input.appointmentId, released: false, change: null };
  await repository.releaseHold(locked.id, input.reasonCode);
  const change: AvailabilityChange = { professionalId: locked.professionalId, dates: [date], scheduleVersion: null, dateVersions };
  await emitAvailabilityChanged(events, change);
  return { appointmentId: locked.id, released: true, change };
}
