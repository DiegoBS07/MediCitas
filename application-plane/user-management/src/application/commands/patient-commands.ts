import type { EventSink } from '@medicitas/messaging';
import { applyPatientPatch, type NewPatientData, type Patient, type PatientPatch } from '../../domain/entities/patient.js';
import { patientIdentificationTaken, patientInactive, patientNotFound } from '../../domain/errors/user-errors.js';
import {
  USER_EVENTS,
  patientContactAccessedPayload,
  patientRegisteredPayload,
  patientUpdatedPayload,
  type ContactAction,
} from '../../domain/events/user-events.js';
import type { PatientRepository } from '../ports/repositories.js';

export interface AuditActor {
  readonly subject: string;
  readonly role: string;
}

/** RF18: every read or write of contact data is announced (→ scheduler audit_log) in the same transaction. */
export async function auditContactAccess(
  events: EventSink,
  patientId: string,
  action: ContactAction,
  actor: AuditActor,
  outcome: 'success' | 'denied' = 'success',
): Promise<void> {
  await events.emit({
    ...USER_EVENTS.patientContactAccessed,
    payload: patientContactAccessedPayload(patientId, action, outcome, actor, new Date()),
  });
}

/** RF14 create. The identification is unique per tenant; the existing patient id is reported (same tenant). */
export async function registerPatient(
  patients: PatientRepository,
  events: EventSink,
  input: { readonly patientId: string; readonly data: NewPatientData; readonly actor: AuditActor },
): Promise<Patient> {
  const duplicate = await patients.findByIdentification(input.data.identificationType, input.data.identificationNumber);
  if (duplicate !== null) throw patientIdentificationTaken(duplicate.id);
  const patient = await patients.insert(input.patientId, input.data, input.actor.subject);
  await events.emit({ ...USER_EVENTS.patientRegistered, payload: patientRegisteredPayload(patient) });
  await auditContactAccess(events, patient.id, 'create', input.actor);
  return patient;
}

/** RF14 read with contact data: audited (RF18). */
export async function readPatient(
  patients: PatientRepository,
  events: EventSink,
  input: { readonly patientId: string; readonly actor: AuditActor },
): Promise<Patient> {
  const patient = await patients.findById(input.patientId);
  if (patient === null) throw patientNotFound();
  await auditContactAccess(events, patient.id, 'read', input.actor);
  return patient;
}

/** RF14 update. PatientUpdated carries field names only; a contact change is audited. */
export async function updatePatient(
  patients: PatientRepository,
  events: EventSink,
  input: { readonly patientId: string; readonly patch: PatientPatch; readonly actor: AuditActor },
): Promise<Patient> {
  const current = await patients.findById(input.patientId, { forUpdate: true });
  if (current === null) throw patientNotFound();
  const result = applyPatientPatch(current, input.patch);
  if (result.changedFields.length === 0) return current;
  const saved = await patients.save(result.patient);
  await events.emit({ ...USER_EVENTS.patientUpdated, payload: patientUpdatedPayload(saved, result.changedFields) });
  if (result.contactChanged) await auditContactAccess(events, saved.id, 'update', input.actor);
  return saved;
}

export type EnsurePatientInput =
  | { readonly mode: 'existing'; readonly patientId: string }
  | { readonly mode: 'create'; readonly patientId: string; readonly patient: NewPatientData; readonly actor: AuditActor };

/**
 * EnsurePatientCommand (RF9 saga step). Idempotent by the orchestrator-generated patientId.
 * Not compensated if the booking later fails (decision-log P2).
 */
export async function ensurePatient(
  patients: PatientRepository,
  events: EventSink,
  input: EnsurePatientInput,
): Promise<{ readonly patientId: string; readonly created: boolean }> {
  const existing = await patients.findById(input.patientId);
  if (input.mode === 'existing') {
    if (existing === null) throw patientNotFound();
    if (existing.status !== 'active') throw patientInactive();
    return { patientId: existing.id, created: false };
  }
  if (existing !== null) return { patientId: existing.id, created: false };
  const patient = await registerPatient(patients, events, { patientId: input.patientId, data: input.patient, actor: input.actor });
  return { patientId: patient.id, created: true };
}
