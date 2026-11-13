import type { CatalogService, Professional, Specialty } from '../entities/catalog.js';

/** Catalog domain events. They feed the scheduler replicas. */
export const CATALOG_EVENTS = {
  specialtyCreated: { messageType: 'SpecialtyCreated', routingKey: 'catalog.specialty.created' },
  serviceCreated: { messageType: 'ServiceCreated', routingKey: 'catalog.service.created' },
  serviceUpdated: { messageType: 'ServiceUpdated', routingKey: 'catalog.service.updated' },
  serviceDeactivated: { messageType: 'ServiceDeactivated', routingKey: 'catalog.service.deactivated' },
  professionalRegistered: { messageType: 'ProfessionalRegistered', routingKey: 'catalog.professional.registered' },
  professionalUpdated: { messageType: 'ProfessionalUpdated', routingKey: 'catalog.professional.updated' },
  professionalServicesChanged: { messageType: 'ProfessionalServicesChanged', routingKey: 'catalog.professional.services-changed' },
} as const;

export const specialtyPayload = (specialty: Specialty) => ({ specialtyId: specialty.id, name: specialty.name });

export const servicePayload = (service: CatalogService) => ({
  serviceId: service.id,
  name: service.name,
  specialtyId: service.specialtyId,
  durationMinutes: service.durationMinutes,
  status: service.status,
  aggregateVersion: service.version,
});

export const professionalPayload = (professional: Professional) => ({
  professionalId: professional.id,
  userId: professional.userId,
  keycloakSubject: professional.keycloakSubject,
  displayName: professional.displayName,
  specialtyId: professional.specialtyId,
  status: professional.status,
  aggregateVersion: professional.version,
});

/** Full replacement set; aggregateVersion = services_version (independent of the profile version). */
export const professionalServicesPayload = (professional: Professional, serviceIds: readonly string[]) => ({
  professionalId: professional.id,
  serviceIds: [...serviceIds],
  aggregateVersion: professional.servicesVersion,
});
