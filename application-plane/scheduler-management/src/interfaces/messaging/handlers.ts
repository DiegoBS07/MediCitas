import { z } from 'zod';
import { isUuid, pgErrorInfo } from '@medicitas/kernel';
import {
  PermanentMessageError,
  TransientMessageError,
  commandHandler,
  eventHandler,
  type HandlerRuntime,
  type InboundMessage,
  type MessageHandler,
} from '@medicitas/messaging';
import { confirmAppointment, holdSlot, releaseSlot } from '../../application/commands/booking.js';
import { toAppointmentView } from '../../domain/entities/appointment.js';
import type { AvailabilityCache } from '../../infrastructure/cache/availability-cache.js';
import { PgReplicaRepository } from '../../infrastructure/persistence/pg-replica-repository.js';
import { PgSchedulerRepository } from '../../infrastructure/persistence/pg-scheduler-repository.js';

export const QUEUES = {
  commands: 'scheduler-management.commands',
  replicas: 'scheduler-management.events.replicas',
  audit: 'scheduler-management.events.audit',
  cacheInvalidation: 'scheduler-management.events.cache-invalidation',
} as const;

export const HoldSlotPayloadV1 = z.object({
  appointmentId: z.uuid(),
  patientId: z.uuid(),
  professionalId: z.uuid(),
  serviceId: z.uuid(),
  startAt: z.iso.datetime({ offset: true }),
});
export const ConfirmAppointmentPayloadV1 = z.object({ appointmentId: z.uuid() });
export const ReleaseSlotPayloadV1 = z.object({ appointmentId: z.uuid(), reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/) });

const TenantOnboardedV1 = z.object({
  tenantId: z.uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  timezone: z.string().min(1),
  status: z.literal('active'),
  aggregateVersion: z.number().int().min(1),
});
const ServiceEventV1 = z.object({
  serviceId: z.uuid(),
  name: z.string().min(1),
  specialtyId: z.uuid(),
  durationMinutes: z.number().int().min(5).max(480),
  status: z.enum(['active', 'inactive']),
  aggregateVersion: z.number().int().min(1),
});
const ProfessionalEventV1 = z.object({
  professionalId: z.uuid(),
  userId: z.uuid(),
  keycloakSubject: z.uuid(),
  displayName: z.string().min(1),
  specialtyId: z.uuid(),
  status: z.enum(['active', 'inactive']),
  aggregateVersion: z.number().int().min(1),
});
const ProfessionalServicesChangedV1 = z.object({
  professionalId: z.uuid(),
  serviceIds: z.array(z.uuid()).max(50),
  aggregateVersion: z.number().int().min(1),
});
export const PatientContactAccessedV1 = z.object({
  patientId: z.uuid(),
  action: z.enum(['read', 'create', 'update']),
  outcome: z.enum(['success', 'denied']),
  actorSubject: z.uuid(),
  actorRole: z.enum(['clinic_admin', 'receptionist', 'health_professional']),
  accessedAt: z.iso.datetime({ offset: true }),
});
const AvailabilityChangedV1 = z.object({ professionalId: z.uuid(), dates: z.array(z.iso.date()).max(400) });

const BOOKING = { allowedProducers: ['appointment-orchestrator'], allowedActorRoles: ['clinic_admin', 'receptionist'] } as const;
const CLINICAL_ACTORS = ['clinic_admin', 'receptionist', 'health_professional', 'platform_admin', 'system'] as const;

function tenantOf(tenantId: string | null): string {
  if (tenantId === null) throw new PermanentMessageError('TENANT_REQUIRED', 'tenant-scoped message without tenantId');
  return tenantId;
}

/** A replica write that hits a missing parent (FK) is retried: events of different aggregates are not ordered. */
async function replicaWrite(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (pgErrorInfo(error).sqlState === '23503') throw new TransientMessageError('REPLICA_PARENT_MISSING', 'parent replica not yet available');
    throw error;
  }
}

export function schedulerHandlers(
  runtime: HandlerRuntime,
  cache: AvailabilityCache,
): Readonly<Record<string, readonly MessageHandler<unknown>[]>> {
  const commands = [
    commandHandler(runtime, QUEUES.commands, {
      ...BOOKING,
      messageType: 'HoldSlotCommand',
      replyType: 'SlotHeldReply',
      payloadSchemas: { 1: HoldSlotPayloadV1 },
      async execute(payload, context) {
        tenantOf(context.envelope.tenantId);
        const actorSubject = context.envelope.actor.subject;
        if (!isUuid(actorSubject)) throw new PermanentMessageError('ACTOR_REQUIRED', 'a human actor is required to book');
        return holdSlot(new PgSchedulerRepository(context.client), context, { ...payload, sagaId: context.envelope.sagaId, actorSubject });
      },
    }),
    commandHandler(runtime, QUEUES.commands, {
      ...BOOKING,
      messageType: 'ConfirmAppointmentCommand',
      replyType: 'AppointmentConfirmedReply',
      payloadSchemas: { 1: ConfirmAppointmentPayloadV1 },
      async execute(payload, context) {
        tenantOf(context.envelope.tenantId);
        return toAppointmentView(await confirmAppointment(new PgSchedulerRepository(context.client), context, payload));
      },
    }),
    commandHandler(runtime, QUEUES.commands, {
      ...BOOKING,
      messageType: 'ReleaseSlotCommand',
      replyType: 'SlotReleasedReply',
      payloadSchemas: { 1: ReleaseSlotPayloadV1 },
      async execute(payload, context) {
        tenantOf(context.envelope.tenantId);
        const result = await releaseSlot(new PgSchedulerRepository(context.client), context, payload);
        return { appointmentId: result.appointmentId, released: result.released };
      },
    }),
  ];

  const fromTenant = { allowedProducers: ['tenant-management'], allowedActorRoles: ['platform_admin', 'system'] } as const;
  const fromCatalog = { allowedProducers: ['catalog-service-management'], allowedActorRoles: CLINICAL_ACTORS } as const;
  const replicas = [
    eventHandler(runtime, QUEUES.replicas, {
      ...fromTenant,
      messageType: 'TenantOnboarded',
      payloadSchemas: { 1: TenantOnboardedV1 },
      async apply(payload, { client, envelope }) {
        if (tenantOf(envelope.tenantId) !== payload.tenantId) throw new PermanentMessageError('TENANT_MISMATCH', 'tenant mismatch');
        await new PgReplicaRepository(client).upsertTenant({ ...payload, id: payload.tenantId, version: payload.aggregateVersion });
      },
    }),
    ...(['ServiceCreated', 'ServiceUpdated', 'ServiceDeactivated'] as const).map((messageType) =>
      eventHandler(runtime, QUEUES.replicas, {
        ...fromCatalog,
        messageType,
        payloadSchemas: { 1: ServiceEventV1 },
        async apply(payload, { client, envelope }) {
          tenantOf(envelope.tenantId);
          await replicaWrite(() =>
            new PgReplicaRepository(client).upsertService({ ...payload, id: payload.serviceId, version: payload.aggregateVersion }),
          );
        },
      }),
    ),
    ...(['ProfessionalRegistered', 'ProfessionalUpdated'] as const).map((messageType) =>
      eventHandler(runtime, QUEUES.replicas, {
        ...fromCatalog,
        messageType,
        payloadSchemas: { 1: ProfessionalEventV1 },
        async apply(payload, { client, envelope }) {
          tenantOf(envelope.tenantId);
          await replicaWrite(() =>
            new PgReplicaRepository(client).upsertProfessional({ ...payload, id: payload.professionalId, version: payload.aggregateVersion }),
          );
        },
      }),
    ),
    eventHandler(runtime, QUEUES.replicas, {
      ...fromCatalog,
      messageType: 'ProfessionalServicesChanged',
      payloadSchemas: { 1: ProfessionalServicesChangedV1 },
      async apply(payload, { client, envelope }) {
        tenantOf(envelope.tenantId);
        await replicaWrite(() =>
          new PgReplicaRepository(client).replaceProfessionalServices(payload.professionalId, payload.serviceIds, payload.aggregateVersion),
        );
      },
    }),
  ];

  const audit = [
    eventHandler(runtime, QUEUES.audit, {
      allowedProducers: ['user-management'],
      allowedActorRoles: ['clinic_admin', 'receptionist', 'health_professional'],
      messageType: 'PatientContactAccessed',
      payloadSchemas: { 1: PatientContactAccessedV1 },
      async apply(payload, { client, envelope }) {
        tenantOf(envelope.tenantId);
        // RF18: append-only row; idempotent by source_message_id (and by the inbox).
        await new PgSchedulerRepository(client).insertAudit({
          occurredAt: new Date(payload.accessedAt),
          actorSubject: payload.actorSubject,
          actorRole: payload.actorRole,
          patientId: payload.patientId,
          resourceType: 'patient_contact',
          resourceId: payload.patientId,
          action: payload.action,
          outcome: payload.outcome,
          correlationId: envelope.correlationId,
          sourceService: 'user-management',
          sourceMessageId: envelope.messageId,
        });
      },
    }),
  ];

  // Cache hygiene only (correctness relies on versioned keys): no database work, no inbox needed.
  const invalidation: MessageHandler<z.infer<typeof AvailabilityChangedV1>> = {
    messageType: 'AvailabilityChanged',
    payloadSchemas: { 1: AvailabilityChangedV1 },
    allowedProducers: ['scheduler-management'],
    allowedActorRoles: CLINICAL_ACTORS,
    async handle(message: InboundMessage<z.infer<typeof AvailabilityChangedV1>>) {
      await cache.invalidate(tenantOf(message.envelope.tenantId), message.payload.professionalId, message.payload.dates);
    },
  };

  return {
    [QUEUES.commands]: commands as readonly MessageHandler<unknown>[],
    [QUEUES.replicas]: replicas as readonly MessageHandler<unknown>[],
    [QUEUES.audit]: audit as readonly MessageHandler<unknown>[],
    [QUEUES.cacheInvalidation]: [invalidation] as readonly MessageHandler<unknown>[],
  };
}
