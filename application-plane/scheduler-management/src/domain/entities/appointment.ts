import { ConflictError } from '@medicitas/kernel';

/** Every status of the aggregate; `held` and `released` are internal (never returned by the API, ADR-0006). */
export const APPOINTMENT_STATUSES = ['held', 'released', 'booked', 'attended', 'no_show', 'cancelled', 'rescheduled'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const PUBLIC_STATUSES = ['booked', 'attended', 'no_show', 'cancelled', 'rescheduled'] as const;
export type PublicStatus = (typeof PUBLIC_STATUSES)[number];

export const OUTCOMES = ['attended', 'no_show'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Appointment aggregate as stored by the scheduler (the single authority on time, I1–I3, I7). */
export interface Appointment {
  readonly id: string;
  readonly tenantId: string;
  readonly patientId: string;
  readonly professionalId: string;
  readonly serviceId: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly durationMinutes: number;
  readonly timezone: string;
  readonly status: AppointmentStatus;
  readonly holdExpiresAt: Date | null;
  readonly sagaId: string | null;
  readonly rescheduledFromId: string | null;
  readonly rescheduledToId: string | null;
  readonly bookedBySubject: string;
  readonly cancelReason: string | null;
  readonly cancelledBySubject: string | null;
  readonly cancelledAt: Date | null;
  readonly outcomeRecordedBySubject: string | null;
  readonly outcomeRecordedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function isPublic(appointment: Appointment): boolean {
  return (PUBLIC_STATUSES as readonly string[]).includes(appointment.status);
}

/** RF13: booked → attended | no_show | cancelled | rescheduled; the four final states have no exit. */
export function assertBooked(appointment: Appointment, action: string): void {
  if (appointment.status !== 'booked') {
    throw new ConflictError('INVALID_STATE_TRANSITION', `Cannot ${action} an appointment in status ${appointment.status}.`);
  }
}

/** Public representation (api-contracts §3.7). */
export function toAppointmentView(appointment: Appointment) {
  return {
    appointmentId: appointment.id,
    patientId: appointment.patientId,
    professionalId: appointment.professionalId,
    serviceId: appointment.serviceId,
    startAt: appointment.startAt.toISOString(),
    endAt: appointment.endAt.toISOString(),
    durationMinutes: appointment.durationMinutes,
    timezone: appointment.timezone,
    status: appointment.status,
    rescheduledFromId: appointment.rescheduledFromId,
    rescheduledToId: appointment.rescheduledToId,
    cancellation:
      appointment.cancelledAt === null
        ? null
        : { reason: appointment.cancelReason, cancelledBy: appointment.cancelledBySubject, cancelledAt: appointment.cancelledAt.toISOString() },
    outcome:
      appointment.outcomeRecordedAt === null
        ? null
        : { recordedBy: appointment.outcomeRecordedBySubject, recordedAt: appointment.outcomeRecordedAt.toISOString() },
    createdAt: appointment.createdAt.toISOString(),
    updatedAt: appointment.updatedAt.toISOString(),
  };
}

export type AppointmentView = ReturnType<typeof toAppointmentView>;

/** AppointmentSummary (conflict lists, api-contracts §3.5). */
export function toAppointmentSummary(appointment: Appointment) {
  return {
    appointmentId: appointment.id,
    patientId: appointment.patientId,
    professionalId: appointment.professionalId,
    serviceId: appointment.serviceId,
    startAt: appointment.startAt.toISOString(),
    endAt: appointment.endAt.toISOString(),
    status: appointment.status,
  };
}
