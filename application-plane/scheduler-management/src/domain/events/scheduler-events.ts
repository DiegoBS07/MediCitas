import type { EventSink } from '@medicitas/messaging';
import type { Appointment } from '../entities/appointment.js';

/** Scheduler domain events (messaging-contracts §8). Payloads never carry note text or patient PII. */
export const SCHEDULER_EVENTS = {
  scheduleDefined: { messageType: 'ProfessionalScheduleDefined', routingKey: 'scheduler.schedule.defined' },
  blockCreated: { messageType: 'CalendarBlockCreated', routingKey: 'scheduler.calendar-block.created' },
  blockRemoved: { messageType: 'CalendarBlockRemoved', routingKey: 'scheduler.calendar-block.removed' },
  appointmentCreated: { messageType: 'AppointmentCreated', routingKey: 'scheduler.appointment.created' },
  appointmentRescheduled: { messageType: 'AppointmentRescheduled', routingKey: 'scheduler.appointment.rescheduled' },
  appointmentCancelled: { messageType: 'AppointmentCancelled', routingKey: 'scheduler.appointment.cancelled' },
  outcomeRecorded: { messageType: 'AppointmentOutcomeRecorded', routingKey: 'scheduler.appointment.outcome-recorded' },
  noteAdded: { messageType: 'ClinicalNoteAdded', routingKey: 'scheduler.clinical-note.added' },
  availabilityChanged: { messageType: 'AvailabilityChanged', routingKey: 'scheduler.availability.changed' },
} as const;

/** (professional, local dates) whose availability changed in a transaction; drives cache invalidation. */
export interface AvailabilityChange {
  readonly professionalId: string;
  readonly dates: readonly string[];
  readonly scheduleVersion: number | null;
  readonly dateVersions: Readonly<Record<string, number>>;
}

export async function emitAvailabilityChanged(events: EventSink, change: AvailabilityChange): Promise<void> {
  await events.emit({
    ...SCHEDULER_EVENTS.availabilityChanged,
    payload: {
      professionalId: change.professionalId,
      dates: [...change.dates],
      scheduleVersion: change.scheduleVersion,
      dateVersions: { ...change.dateVersions },
    },
  });
}

export const appointmentCreatedPayload = (appointment: Appointment) => ({
  appointmentId: appointment.id,
  patientId: appointment.patientId,
  professionalId: appointment.professionalId,
  serviceId: appointment.serviceId,
  startAt: appointment.startAt.toISOString(),
  endAt: appointment.endAt.toISOString(),
  durationMinutes: appointment.durationMinutes,
  status: 'booked',
  aggregateVersion: appointment.version,
});
