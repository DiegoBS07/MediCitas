import { BusinessRuleError, ConflictError, NotFoundError } from '@medicitas/kernel';

export const userNotFound = (): NotFoundError => new NotFoundError('user', 'User not found.');
export const patientNotFound = (): NotFoundError => new NotFoundError('patient', 'Patient not found.');

export const emailTaken = (): ConflictError => new ConflictError('EMAIL_TAKEN', 'The e-mail address is already registered.');

export const lastClinicAdmin = (): ConflictError =>
  new ConflictError('LAST_CLINIC_ADMIN', 'The last active clinic administrator cannot be demoted or deactivated.');

export const patientInactive = (): BusinessRuleError => new BusinessRuleError('PATIENT_INACTIVE', 'The patient is inactive.');

export function patientIdentificationTaken(existingPatientId: string | null): ConflictError {
  return new ConflictError('PATIENT_IDENTIFICATION_TAKEN', 'A patient with this identification already exists.', {
    meta: existingPatientId === null ? {} : { patientId: existingPatientId, existingPatientId },
  });
}
