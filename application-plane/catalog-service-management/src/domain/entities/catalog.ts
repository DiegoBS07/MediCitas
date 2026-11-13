import { BusinessRuleError, ValidationError } from '@medicitas/kernel';

export const CATALOG_STATUSES = ['active', 'inactive'] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

export interface Specialty {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly createdAt: Date;
}

/** A bookable service (RF3). Its duration defines every appointment interval (I4). */
export interface CatalogService {
  readonly id: string;
  readonly tenantId: string;
  readonly specialtyId: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly status: CatalogStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A health professional of the clinic (RF4), linked 1:1 to a clinic user with that role. */
export interface Professional {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly keycloakSubject: string;
  readonly specialtyId: string;
  readonly displayName: string;
  readonly licenseNumber: string;
  readonly status: CatalogStatus;
  readonly version: number;
  readonly servicesVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Durations: 5–480 minutes, multiples of 5 (decision-log P7; database CHECK services_duration_range). */
export function assertDuration(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480 || minutes % 5 !== 0) {
    throw new ValidationError('Invalid service duration.', [
      { path: 'body.durationMinutes', message: 'must be a multiple of 5 between 5 and 480' },
    ]);
  }
  return minutes;
}

/** RF4: a professional only performs services of their specialty, and only active ones. */
export function assertAssignable(professional: Professional, services: readonly CatalogService[]): void {
  for (const service of services) {
    if (service.specialtyId !== professional.specialtyId) {
      throw new BusinessRuleError('SPECIALTY_MISMATCH', `The service ${service.id} belongs to another specialty.`);
    }
    if (service.status !== 'active') {
      throw new BusinessRuleError('SERVICE_INACTIVE', `The service ${service.id} is inactive.`);
    }
  }
}

/**
 * RF9 catalog step: the professional exists, is active, offers the service, and the service is
 * active. Returns the authoritative duration and versions used to cross-check the scheduler replica.
 */
export function validateBooking(
  professional: Professional | null,
  service: CatalogService | null,
  offered: boolean,
): { readonly durationMinutes: number; readonly serviceVersion: number; readonly professionalVersion: number } {
  if (professional === null || service === null) {
    throw new BusinessRuleError('RESOURCE_NOT_FOUND', 'The professional or the service does not exist in this clinic.');
  }
  if (professional.status !== 'active') throw new BusinessRuleError('PROFESSIONAL_INACTIVE', 'The professional is inactive.');
  if (service.status !== 'active') throw new BusinessRuleError('SERVICE_INACTIVE', 'The service is inactive.');
  if (!offered) throw new BusinessRuleError('PROFESSIONAL_NOT_QUALIFIED', 'The professional does not offer this service.');
  return { durationMinutes: service.durationMinutes, serviceVersion: service.version, professionalVersion: professional.version };
}
