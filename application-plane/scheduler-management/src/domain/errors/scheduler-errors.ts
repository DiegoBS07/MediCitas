import { AuthorizationError, BusinessRuleError, ConflictError, NotFoundError, ValidationError, pgErrorInfo, type AppError } from '@medicitas/kernel';

export const appointmentNotFound = (): NotFoundError => new NotFoundError('appointment', 'Appointment not found.');
export const professionalNotFound = (): NotFoundError => new NotFoundError('professional', 'Professional not found.');
export const serviceNotFound = (): NotFoundError => new NotFoundError('service', 'Service not found.');
export const blockNotFound = (): NotFoundError => new NotFoundError('calendar_block', 'Calendar block not found.');
export const noteNotFound = (): NotFoundError => new NotFoundError('clinical_note', 'Clinical note not found.');

export const slotInPast = (): BusinessRuleError => new BusinessRuleError('SLOT_IN_PAST', 'The start must be in the future.');
export const beyondHorizon = (): BusinessRuleError =>
  new BusinessRuleError('DATE_RANGE_TOO_LARGE', 'The date is beyond the booking horizon.');
export const professionalInactive = (): BusinessRuleError => new BusinessRuleError('PROFESSIONAL_INACTIVE', 'The professional is inactive.');
export const holdExpired = (): BusinessRuleError => new BusinessRuleError('HOLD_EXPIRED', 'The slot hold expired before confirmation.');
export const dateRangeTooLarge = (maxDays: number): BusinessRuleError =>
  new BusinessRuleError('DATE_RANGE_TOO_LARGE', `The range may span at most ${maxDays} days.`);
export const notOwnProfessional = (): AuthorizationError => new AuthorizationError('The caller may only act on their own professional profile.');

/**
 * Maps the constraint/trigger that rejected a statement to the stable business code (ADR-0007).
 * 23P01 exclusion violations are business answers (I1/I2), never retried.
 */
const BY_CONSTRAINT: Readonly<Record<string, () => AppError>> = {
  appointments_no_professional_overlap: () =>
    new ConflictError('SLOT_TAKEN', 'The requested interval overlaps an active appointment of the professional.'),
  appointments_no_patient_overlap: () => new ConflictError('PATIENT_OVERLAP', 'The patient already has an overlapping active appointment.'),
  appointments_within_working_hours: () =>
    new BusinessRuleError('OUTSIDE_WORKING_HOURS', 'The interval is not inside the working hours of the professional.'),
  appointments_slot_aligned: () => new BusinessRuleError('SLOT_MISALIGNED', 'The start is not on the slot grid.'),
  appointments_outside_calendar_blocks: () => new BusinessRuleError('SLOT_BLOCKED', 'The interval overlaps a calendar block.'),
  appointments_professional_active: () => professionalInactive(),
  appointments_service_active: () => new BusinessRuleError('SERVICE_INACTIVE', 'The service is inactive.'),
  appointments_professional_offers_service: () =>
    new BusinessRuleError('PROFESSIONAL_NOT_QUALIFIED', 'The professional does not offer this service.'),
  appointments_valid_transition: () => new ConflictError('INVALID_STATE_TRANSITION', 'The transition is not allowed.'),
  appointments_outcome_after_start: () =>
    new BusinessRuleError('OUTCOME_BEFORE_START', 'An outcome can only be recorded after the start time.'),
  appointments_professional_fk: () => professionalNotFound(),
  appointments_service_fk: () => serviceNotFound(),
  weekly_schedule_blocks_no_overlap: () => new ConflictError('SCHEDULE_OVERLAP', 'Two blocks of the same weekday overlap.'),
  clinical_notes_appointment_unique: () => new ConflictError('CLINICAL_NOTE_EXISTS', 'The appointment already has a clinical note.'),
  clinical_notes_requires_attended: () =>
    new BusinessRuleError('CLINICAL_NOTE_REQUIRES_ATTENDED', 'A clinical note requires an attended appointment.'),
  clinical_notes_author_is_professional: () => new AuthorizationError('Only the professional of the appointment may write its note.'),
  calendar_blocks_period_max_span: () => dateRangeTooLarge(90),
};

/** Rethrows a database error as its business error when the constraint is known. */
export function mapSchedulerConstraint(error: unknown): never {
  const info = pgErrorInfo(error);
  const factory = info.constraint === null ? undefined : BY_CONSTRAINT[info.constraint];
  if (factory !== undefined) throw factory();
  if (info.sqlState === '23514') {
    throw new ValidationError('The request violates a data rule.', [{ path: 'body', message: info.constraint ?? 'check violation' }]);
  }
  throw error;
}

export async function guardConstraints<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    return mapSchedulerConstraint(error);
  }
}
