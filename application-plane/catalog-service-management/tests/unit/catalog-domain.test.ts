import { describe, expect, it } from 'vitest';
import { assertAssignable, assertDuration, validateBooking, type CatalogService, type Professional } from '../../src/domain/entities/catalog.js';

const now = new Date();
const professional: Professional = {
  id: 'p',
  tenantId: 't',
  userId: 'u',
  keycloakSubject: 's',
  specialtyId: 'general',
  displayName: 'Dr. Test',
  licenseNumber: 'LIC-1',
  status: 'active',
  version: 4,
  servicesVersion: 2,
  createdAt: now,
  updatedAt: now,
};
const service: CatalogService = {
  id: 'svc',
  tenantId: 't',
  specialtyId: 'general',
  name: 'Consultation',
  durationMinutes: 30,
  status: 'active',
  version: 7,
  createdAt: now,
  updatedAt: now,
};

describe('catalog rules', () => {
  it('accepts durations that are multiples of 5 between 5 and 480 (I4)', () => {
    expect(assertDuration(5)).toBe(5);
    expect(assertDuration(480)).toBe(480);
    for (const invalid of [0, 3, 7, 485, 12.5]) expect(() => assertDuration(invalid)).toThrowError();
  });

  it('allows only same-specialty active services to be associated (RF4)', () => {
    expect(() => assertAssignable(professional, [service])).not.toThrow();
    expect(() => assertAssignable(professional, [{ ...service, specialtyId: 'pediatrics' }])).toThrowError(
      expect.objectContaining({ code: 'SPECIALTY_MISMATCH' }),
    );
    expect(() => assertAssignable(professional, [{ ...service, status: 'inactive' }])).toThrowError(
      expect.objectContaining({ code: 'SERVICE_INACTIVE' }),
    );
  });

  it('validates a booking and returns the authoritative duration and versions (RF9)', () => {
    expect(validateBooking(professional, service, true)).toEqual({ durationMinutes: 30, serviceVersion: 7, professionalVersion: 4 });
    expect(() => validateBooking(null, service, false)).toThrowError(expect.objectContaining({ code: 'RESOURCE_NOT_FOUND' }));
    expect(() => validateBooking({ ...professional, status: 'inactive' }, service, true)).toThrowError(
      expect.objectContaining({ code: 'PROFESSIONAL_INACTIVE' }),
    );
    expect(() => validateBooking(professional, { ...service, status: 'inactive' }, true)).toThrowError(
      expect.objectContaining({ code: 'SERVICE_INACTIVE' }),
    );
    expect(() => validateBooking(professional, service, false)).toThrowError(expect.objectContaining({ code: 'PROFESSIONAL_NOT_QUALIFIED' }));
  });
});
