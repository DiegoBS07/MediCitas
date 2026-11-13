import { BusinessRuleError, ConflictError, NotFoundError } from '@medicitas/kernel';

export const specialtyNotFound = (): NotFoundError => new NotFoundError('specialty', 'Specialty not found.');
export const serviceNotFound = (): NotFoundError => new NotFoundError('service', 'Service not found.');
export const professionalNotFound = (): NotFoundError => new NotFoundError('professional', 'Professional not found.');
export const userNotFound = (): NotFoundError => new NotFoundError('user', 'User not found.');

export const specialtyNameTaken = (): ConflictError =>
  new ConflictError('SPECIALTY_NAME_TAKEN', 'A specialty with this name already exists.');
export const serviceNameTaken = (): ConflictError => new ConflictError('SERVICE_NAME_TAKEN', 'A service with this name already exists.');
export const professionalAlreadyRegistered = (detail: string): ConflictError =>
  new ConflictError('PROFESSIONAL_ALREADY_REGISTERED', detail);
export const specialtyChangeConflict = (): ConflictError =>
  new ConflictError('SPECIALTY_CHANGE_CONFLICT', 'The new specialty conflicts with the current service associations.');
export const userNotEligible = (): BusinessRuleError =>
  new BusinessRuleError('USER_NOT_ELIGIBLE', 'The user is not an active health professional of this clinic.');
