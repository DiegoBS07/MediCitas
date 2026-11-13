import type { Appointment, AppointmentStatus, Outcome } from '../../domain/entities/appointment.js';
import type { WeeklyBlock } from '../../domain/services/weekly-schedule.js';

export interface ProfessionalReplica {
  readonly id: string;
  readonly keycloakSubject: string;
  readonly displayName: string;
  readonly specialtyId: string;
  readonly status: 'active' | 'inactive';
}

export interface ServiceReplica {
  readonly id: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly status: 'active' | 'inactive';
  readonly version: number;
}

/** Interval facts computed with the DATABASE clock and the tenant timezone (no application clock skew). */
export interface SlotContext {
  readonly timezone: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly localDate: string;
  readonly inPast: boolean;
  readonly beyondHorizon: boolean;
  readonly holdTtlSeconds: number;
}

export interface NewAppointment {
  readonly id: string;
  readonly patientId: string;
  readonly professionalId: string;
  readonly serviceId: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly status: 'held' | 'booked';
  readonly holdTtlSeconds: number | null;
  readonly sagaId: string | null;
  readonly rescheduledFromId: string | null;
  readonly bookedBySubject: string;
}

export interface CalendarBlock {
  readonly id: string;
  readonly professionalId: string;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly reason: 'vacation' | 'leave' | 'other';
  readonly note: string | null;
  readonly status: 'active' | 'removed';
  readonly createdAt: Date;
}

export interface ConflictRow {
  readonly appointment: Appointment;
  readonly outsideWorkingHours: boolean;
  readonly blocked: boolean;
}

export interface AuditEntry {
  readonly occurredAt: Date | null;
  readonly actorSubject: string;
  readonly actorRole: string;
  readonly patientId: string;
  readonly resourceType: 'clinical_note' | 'patient_contact';
  readonly resourceId: string;
  readonly action: 'read' | 'create' | 'update';
  readonly outcome: 'success' | 'denied';
  readonly correlationId: string;
  readonly sourceService: 'scheduler-management' | 'user-management';
  readonly sourceMessageId: string | null;
}

/** Persistence port of the scheduler (inside the caller's transaction; RLS by tenant). */
export interface SchedulerRepository {
  // Agenda anchors and versions (anchors → versions → appointments)
  lockAnchors(professionalIds: readonly string[], mode: 'SHARE' | 'UPDATE'): Promise<readonly string[]>;
  bumpDateVersions(professionalId: string, dates: readonly string[]): Promise<Readonly<Record<string, number>>>;
  bumpScheduleVersion(professionalId: string): Promise<number>;
  scheduleVersion(professionalId: string): Promise<number>;
  tenantTimezone(): Promise<string>;

  // Replicas
  professional(id: string): Promise<ProfessionalReplica | null>;
  professionalBySubject(subject: string): Promise<ProfessionalReplica | null>;
  service(id: string): Promise<ServiceReplica | null>;
  offers(professionalId: string, serviceId: string): Promise<boolean>;

  // Appointments
  slotContext(startAt: string, durationMinutes: number): Promise<SlotContext>;
  findAppointment(id: string, options?: { readonly forUpdate?: boolean }): Promise<Appointment | null>;
  insertAppointment(appointment: NewAppointment): Promise<Appointment>;
  confirmHold(id: string): Promise<Appointment>;
  releaseHold(id: string, reasonCode: string): Promise<Appointment>;
  markRescheduled(id: string): Promise<Appointment>;
  cancel(id: string, reason: string, bySubject: string): Promise<Appointment>;
  recordOutcome(id: string, outcome: Outcome, bySubject: string): Promise<Appointment>;
  localDateOf(instant: Date): Promise<string>;
  dbNow(): Promise<Date>;

  // Weekly schedule and blocks
  replaceWeeklyBlocks(professionalId: string, blocks: readonly WeeklyBlock[]): Promise<void>;
  weeklyBlocks(professionalId: string): Promise<readonly WeeklyBlock[]>;
  insertCalendarBlock(block: {
    readonly id: string;
    readonly professionalId: string;
    readonly startAt: string;
    readonly endAt: string;
    readonly reason: CalendarBlock['reason'];
    readonly note: string | null;
    readonly createdBySubject: string;
  }): Promise<CalendarBlock>;
  findCalendarBlock(professionalId: string, blockId: string, options?: { readonly forUpdate?: boolean }): Promise<CalendarBlock | null>;
  removeCalendarBlock(blockId: string, bySubject: string): Promise<void>;
  listCalendarBlocks(professionalId: string, from: string, to: string): Promise<readonly CalendarBlock[]>;
  localDatesSpanned(startAt: Date, endAt: Date): Promise<readonly string[]>;
  bookedOverlapping(professionalId: string, startAt: Date, endAt: Date): Promise<readonly Appointment[]>;
  futureOutsideWorkingHours(professionalId: string): Promise<readonly Appointment[]>;
  conflicts(filter: { readonly professionalId: string | null; readonly from: string; readonly to: string }): Promise<readonly ConflictRow[]>;

  // Clinical notes and audit
  insertNote(note: { readonly id: string; readonly appointmentId: string; readonly authorSubject: string; readonly content: string }): Promise<Date>;
  findNote(appointmentId: string): Promise<{ readonly id: string; readonly authorSubject: string; readonly content: string; readonly createdAt: Date } | null>;
  insertAudit(entry: AuditEntry): Promise<void>;

}

export type { AppointmentStatus };
