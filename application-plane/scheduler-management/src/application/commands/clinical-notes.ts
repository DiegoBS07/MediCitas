import { newId } from '@medicitas/kernel';
import type { EventSink } from '@medicitas/messaging';
import { isPublic, type Appointment } from '../../domain/entities/appointment.js';
import { appointmentNotFound, noteNotFound } from '../../domain/errors/scheduler-errors.js';
import { SCHEDULER_EVENTS } from '../../domain/events/scheduler-events.js';
import { BusinessRuleError } from '@medicitas/kernel';
import type { SchedulerRepository } from '../ports/scheduler-ports.js';

/** Caller of a clinical-note route; `mayUseNotes` = the clinical-notes:own permission. */
export interface NoteCaller {
  readonly subject: string;
  readonly role: string;
  readonly mayUseNotes: boolean;
  readonly correlationId: string;
}

export type NoteOutcome<T> = { readonly kind: 'ok'; readonly value: T } | { readonly kind: 'denied' };

/**
 * Only the professional of the appointment may write or read its note (RF15). Every attempt that
 * is denied is still written to the audit log (RF18) in the same transaction, which then COMMITS;
 * the caller turns `denied` into 403 after the commit.
 */
async function authorize(
  repository: SchedulerRepository,
  appointmentId: string,
  caller: NoteCaller,
  action: 'read' | 'create',
): Promise<{ readonly appointment: Appointment; readonly allowed: boolean }> {
  const appointment = await repository.findAppointment(appointmentId);
  if (appointment === null || !isPublic(appointment)) throw appointmentNotFound();
  const professional = await repository.professional(appointment.professionalId);
  const allowed = caller.mayUseNotes && professional !== null && professional.keycloakSubject === caller.subject;
  if (!allowed) {
    await repository.insertAudit({
      occurredAt: null,
      actorSubject: caller.subject,
      actorRole: caller.role,
      patientId: appointment.patientId,
      resourceType: 'clinical_note',
      resourceId: appointment.id,
      action,
      outcome: 'denied',
      correlationId: caller.correlationId,
      sourceService: 'scheduler-management',
      sourceMessageId: null,
    });
  }
  return { appointment, allowed };
}

export async function writeClinicalNote(
  repository: SchedulerRepository,
  events: EventSink,
  input: { readonly appointmentId: string; readonly content: string; readonly caller: NoteCaller },
): Promise<NoteOutcome<{ readonly noteId: string; readonly appointmentId: string; readonly patientId: string; readonly authorSubject: string; readonly createdAt: string }>> {
  const { appointment, allowed } = await authorize(repository, input.appointmentId, input.caller, 'create');
  if (!allowed) return { kind: 'denied' };
  if (appointment.status !== 'attended') {
    throw new BusinessRuleError('CLINICAL_NOTE_REQUIRES_ATTENDED', 'A clinical note requires an attended appointment.');
  }
  const noteId = newId();
  const createdAt = await repository.insertNote({ id: noteId, appointmentId: appointment.id, authorSubject: input.caller.subject, content: input.content });
  await repository.insertAudit({
    occurredAt: null,
    actorSubject: input.caller.subject,
    actorRole: input.caller.role,
    patientId: appointment.patientId,
    resourceType: 'clinical_note',
    resourceId: noteId,
    action: 'create',
    outcome: 'success',
    correlationId: input.caller.correlationId,
    sourceService: 'scheduler-management',
    sourceMessageId: null,
  });
  await events.emit({
    ...SCHEDULER_EVENTS.noteAdded,
    payload: { noteId, appointmentId: appointment.id, patientId: appointment.patientId, authorSubject: input.caller.subject },
  });
  return {
    kind: 'ok',
    value: { noteId, appointmentId: appointment.id, patientId: appointment.patientId, authorSubject: input.caller.subject, createdAt: createdAt.toISOString() },
  };
}

export async function readClinicalNote(
  repository: SchedulerRepository,
  input: { readonly appointmentId: string; readonly caller: NoteCaller },
): Promise<NoteOutcome<{ readonly noteId: string; readonly appointmentId: string; readonly patientId: string; readonly authorSubject: string; readonly content: string; readonly createdAt: string }>> {
  const { appointment, allowed } = await authorize(repository, input.appointmentId, input.caller, 'read');
  if (!allowed) return { kind: 'denied' };
  const note = await repository.findNote(appointment.id);
  if (note === null) throw noteNotFound();
  await repository.insertAudit({
    occurredAt: null,
    actorSubject: input.caller.subject,
    actorRole: input.caller.role,
    patientId: appointment.patientId,
    resourceType: 'clinical_note',
    resourceId: note.id,
    action: 'read',
    outcome: 'success',
    correlationId: input.caller.correlationId,
    sourceService: 'scheduler-management',
    sourceMessageId: null,
  });
  return {
    kind: 'ok',
    value: {
      noteId: note.id,
      appointmentId: appointment.id,
      patientId: appointment.patientId,
      authorSubject: note.authorSubject,
      content: note.content,
      createdAt: note.createdAt.toISOString(),
    },
  };
}
