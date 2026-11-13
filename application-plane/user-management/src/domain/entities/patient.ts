export const IDENTIFICATION_TYPES = ['national_id', 'passport', 'residence_card', 'other'] as const;
export type IdentificationType = (typeof IDENTIFICATION_TYPES)[number];

export const PATIENT_STATUSES = ['active', 'inactive'] as const;
export type PatientStatus = (typeof PATIENT_STATUSES)[number];

/** Contact data: audited on every read and write (RF18). */
export interface PatientContact {
  readonly email: string | null;
  readonly phone: string | null;
  readonly address: string | null;
}

/** Patient of a clinic (RF14). Patients are not system users. */
export interface Patient {
  readonly id: string;
  readonly tenantId: string;
  readonly identificationType: IdentificationType;
  readonly identificationNumber: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly birthDate: string;
  readonly contact: PatientContact;
  readonly status: PatientStatus;
  readonly createdBySubject: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewPatientData {
  readonly identificationType: IdentificationType;
  readonly identificationNumber: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly birthDate: string;
  readonly contact: Partial<PatientContact>;
}

export interface PatientPatch {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly birthDate?: string;
  readonly contact?: Partial<PatientContact>;
  readonly status?: PatientStatus;
}

export interface PatchResult {
  readonly patient: Patient;
  /** Names of the fields that changed (never their values: PatientUpdated carries names only). */
  readonly changedFields: readonly string[];
  readonly contactChanged: boolean;
}

/** Applies a partial update; unchanged values do not count as changes and do not bump the version. */
export function applyPatientPatch(patient: Patient, patch: PatientPatch): PatchResult {
  const changed: string[] = [];
  const next = { ...patient, contact: { ...patient.contact } };
  const scalar = ['firstName', 'lastName', 'birthDate', 'status'] as const;
  for (const field of scalar) {
    const value = patch[field];
    if (value !== undefined && value !== patient[field]) {
      (next as Record<(typeof scalar)[number], string>)[field] = value;
      changed.push(field);
    }
  }
  let contactChanged = false;
  for (const field of ['email', 'phone', 'address'] as const) {
    const value = patch.contact?.[field];
    if (value !== undefined && value !== patient.contact[field]) {
      next.contact[field] = value;
      changed.push(`contact.${field}`);
      contactChanged = true;
    }
  }
  return {
    patient: changed.length === 0 ? patient : { ...next, version: patient.version + 1 },
    changedFields: changed,
    contactChanged,
  };
}
