import type { CatalogService, Professional, Specialty } from '../../domain/entities/catalog.js';

/** Public representations. */
export const toSpecialtyView = (specialty: Specialty) => ({
  specialtyId: specialty.id,
  name: specialty.name,
  createdAt: specialty.createdAt.toISOString(),
});

export const toServiceView = (service: CatalogService) => ({
  serviceId: service.id,
  name: service.name,
  specialtyId: service.specialtyId,
  durationMinutes: service.durationMinutes,
  status: service.status,
  version: service.version,
  createdAt: service.createdAt.toISOString(),
  updatedAt: service.updatedAt.toISOString(),
});

export const toProfessionalView = (professional: Professional) => ({
  professionalId: professional.id,
  userId: professional.userId,
  keycloakSubject: professional.keycloakSubject,
  displayName: professional.displayName,
  licenseNumber: professional.licenseNumber,
  specialtyId: professional.specialtyId,
  status: professional.status,
  version: professional.version,
  createdAt: professional.createdAt.toISOString(),
  updatedAt: professional.updatedAt.toISOString(),
});
