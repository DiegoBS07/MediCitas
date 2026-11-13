import { newId } from '@medicitas/kernel';
import type { EventSink } from '@medicitas/messaging';
import { assertAssignable, assertDuration, validateBooking, type CatalogService, type CatalogStatus, type Professional, type Specialty } from '../../domain/entities/catalog.js';
import {
  professionalNotFound,
  serviceNotFound,
  specialtyNotFound,
  userNotEligible,
  userNotFound,
} from '../../domain/errors/catalog-errors.js';
import {
  CATALOG_EVENTS,
  professionalPayload,
  professionalServicesPayload,
  servicePayload,
  specialtyPayload,
} from '../../domain/events/catalog-events.js';
import type { CatalogRepository, DirectoryUser } from '../ports/catalog-ports.js';

export async function createSpecialty(repository: CatalogRepository, events: EventSink, name: string): Promise<Specialty> {
  const specialty = await repository.insertSpecialty(newId(), name.trim());
  await events.emit({ ...CATALOG_EVENTS.specialtyCreated, payload: specialtyPayload(specialty) });
  return specialty;
}

export async function createService(
  repository: CatalogRepository,
  events: EventSink,
  input: { readonly name: string; readonly specialtyId: string; readonly durationMinutes: number },
): Promise<CatalogService> {
  if ((await repository.findSpecialty(input.specialtyId)) === null) throw specialtyNotFound();
  const service = await repository.insertService({
    id: newId(),
    specialtyId: input.specialtyId,
    name: input.name.trim(),
    durationMinutes: assertDuration(input.durationMinutes),
  });
  await events.emit({ ...CATALOG_EVENTS.serviceCreated, payload: servicePayload(service) });
  return service;
}

/**
 * RF3 update. A duration change affects FUTURE bookings only (I4): stored appointment intervals
 * are never recomputed. Deactivation is announced with its own event type.
 */
export async function updateService(
  repository: CatalogRepository,
  events: EventSink,
  input: { readonly serviceId: string; readonly name?: string; readonly durationMinutes?: number; readonly status?: CatalogStatus },
): Promise<CatalogService> {
  const current = await repository.findService(input.serviceId, { forUpdate: true });
  if (current === null) throw serviceNotFound();
  const next: CatalogService = {
    ...current,
    name: input.name?.trim() ?? current.name,
    durationMinutes: input.durationMinutes === undefined ? current.durationMinutes : assertDuration(input.durationMinutes),
    status: input.status ?? current.status,
  };
  if (next.name === current.name && next.durationMinutes === current.durationMinutes && next.status === current.status) return current;
  const saved = await repository.saveService({ ...next, version: current.version + 1 });
  const event = saved.status === 'inactive' && current.status === 'active' ? CATALOG_EVENTS.serviceDeactivated : CATALOG_EVENTS.serviceUpdated;
  await events.emit({ ...event, payload: servicePayload(saved) });
  return saved;
}

/**
 * RF4 registration. The user is checked against user-management BEFORE the transaction (correlated
 * query); only an active health_professional of the same tenant is eligible.
 */
export async function registerProfessional(
  repository: CatalogRepository,
  events: EventSink,
  input: {
    readonly user: DirectoryUser | null;
    readonly userId: string;
    readonly specialtyId: string;
    readonly displayName: string;
    readonly licenseNumber: string;
  },
): Promise<Professional> {
  if (input.user === null) throw userNotFound();
  if (input.user.role !== 'health_professional' || input.user.status !== 'active' || input.user.keycloakSubject === null) {
    throw userNotEligible();
  }
  if ((await repository.findSpecialty(input.specialtyId)) === null) throw specialtyNotFound();
  const professional = await repository.insertProfessional({
    id: newId(),
    userId: input.userId,
    keycloakSubject: input.user.keycloakSubject,
    specialtyId: input.specialtyId,
    displayName: input.displayName.trim(),
    licenseNumber: input.licenseNumber,
  });
  await events.emit({ ...CATALOG_EVENTS.professionalRegistered, payload: professionalPayload(professional) });
  return professional;
}

export async function updateProfessional(
  repository: CatalogRepository,
  events: EventSink,
  input: {
    readonly professionalId: string;
    readonly displayName?: string;
    readonly licenseNumber?: string;
    readonly specialtyId?: string;
    readonly status?: CatalogStatus;
  },
): Promise<Professional> {
  const current = await repository.findProfessional(input.professionalId, { forUpdate: true });
  if (current === null) throw professionalNotFound();
  if (input.specialtyId !== undefined && input.specialtyId !== current.specialtyId && (await repository.findSpecialty(input.specialtyId)) === null) {
    throw specialtyNotFound();
  }
  const next: Professional = {
    ...current,
    displayName: input.displayName?.trim() ?? current.displayName,
    licenseNumber: input.licenseNumber ?? current.licenseNumber,
    specialtyId: input.specialtyId ?? current.specialtyId,
    status: input.status ?? current.status,
  };
  const unchanged =
    next.displayName === current.displayName &&
    next.licenseNumber === current.licenseNumber &&
    next.specialtyId === current.specialtyId &&
    next.status === current.status;
  if (unchanged) return current;
  const saved = await repository.saveProfessional({ ...next, version: current.version + 1 });
  await events.emit({ ...CATALOG_EVENTS.professionalUpdated, payload: professionalPayload(saved) });
  return saved;
}

/** RF4 associations: replaces the whole set atomically; every service must match the specialty and be active. */
export async function replaceProfessionalServices(
  repository: CatalogRepository,
  events: EventSink,
  input: { readonly professionalId: string; readonly serviceIds: readonly string[] },
): Promise<{ readonly professional: Professional; readonly serviceIds: readonly string[] }> {
  const professional = await repository.findProfessional(input.professionalId, { forUpdate: true });
  if (professional === null) throw professionalNotFound();
  const serviceIds = [...new Set(input.serviceIds)].sort();
  const services = await repository.findServices(serviceIds);
  if (services.length !== serviceIds.length) throw serviceNotFound();
  const current = await repository.professionalServiceIds(professional.id);
  // Only additions are checked: kept associations were valid when created (a service deactivated
  // later may stay associated, but an inactive service cannot be added).
  assertAssignable(professional, services.filter((service) => !current.includes(service.id)));
  if (current.length === serviceIds.length && current.every((id, index) => id === serviceIds[index])) {
    return { professional, serviceIds };
  }
  await repository.replaceProfessionalServices(professional.id, serviceIds);
  const saved = await repository.saveProfessional({ ...professional, servicesVersion: professional.servicesVersion + 1 });
  await events.emit({ ...CATALOG_EVENTS.professionalServicesChanged, payload: professionalServicesPayload(saved, serviceIds) });
  return { professional: saved, serviceIds };
}

/** Reaction to TenantUserDeactivated (ADR-0012): the linked professional stops taking new bookings. */
export async function deactivateProfessionalOfUser(repository: CatalogRepository, events: EventSink, userId: string): Promise<void> {
  const professional = await repository.findProfessionalByUser(userId, { forUpdate: true });
  if (professional === null || professional.status === 'inactive') return;
  const saved = await repository.saveProfessionalStatus({ ...professional, status: 'inactive', version: professional.version + 1 });
  await events.emit({ ...CATALOG_EVENTS.professionalUpdated, payload: professionalPayload(saved) });
}

/** ValidateBookingCatalogCommand (RF9 saga step). */
export async function validateBookingCatalog(
  repository: CatalogRepository,
  input: { readonly professionalId: string; readonly serviceId: string },
): Promise<{ readonly durationMinutes: number; readonly serviceVersion: number; readonly professionalVersion: number }> {
  const [professional, service] = await Promise.all([
    repository.findProfessional(input.professionalId),
    repository.findService(input.serviceId),
  ]);
  const offered = professional !== null && service !== null && (await repository.offers(professional.id, service.id));
  return validateBooking(professional, service, offered);
}
