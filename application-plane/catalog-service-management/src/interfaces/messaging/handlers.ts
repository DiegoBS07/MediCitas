import { z } from 'zod';
import { PermanentMessageError, commandHandler, eventHandler, type HandlerRuntime, type MessageHandler } from '@medicitas/messaging';
import { deactivateProfessionalOfUser, validateBookingCatalog } from '../../application/commands/catalog-commands.js';
import { PgCatalogRepository } from '../../infrastructure/persistence/pg-catalog-repository.js';

export const QUEUES = {
  commands: 'catalog-service-management.commands',
  replicas: 'catalog-service-management.events.replicas',
} as const;

export const ValidateBookingCatalogPayloadV1 = z.object({ professionalId: z.uuid(), serviceId: z.uuid() });
export const TenantOnboardedPayloadV1 = z.object({
  tenantId: z.uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  timezone: z.string().min(1),
  status: z.literal('active'),
  aggregateVersion: z.number().int().min(1),
});
export const TenantUserDeactivatedPayloadV1 = z.object({
  userId: z.uuid(),
  keycloakSubject: z.uuid().nullable(),
  aggregateVersion: z.number().int().min(1),
});

function tenantOf(tenantId: string | null): string {
  if (tenantId === null) throw new PermanentMessageError('TENANT_REQUIRED', 'tenant-scoped message without tenantId');
  return tenantId;
}

export function catalogHandlers(runtime: HandlerRuntime): Readonly<Record<string, readonly MessageHandler<unknown>[]>> {
  const commands = [
    commandHandler(runtime, QUEUES.commands, {
      messageType: 'ValidateBookingCatalogCommand',
      replyType: 'BookingCatalogValidatedReply',
      allowedProducers: ['appointment-orchestrator'],
      allowedActorRoles: ['clinic_admin', 'receptionist'],
      payloadSchemas: { 1: ValidateBookingCatalogPayloadV1 },
      async execute(payload, { client, envelope }) {
        tenantOf(envelope.tenantId);
        return validateBookingCatalog(new PgCatalogRepository(client), payload);
      },
    }),
  ];

  const replicas = [
    eventHandler(runtime, QUEUES.replicas, {
      messageType: 'TenantOnboarded',
      allowedProducers: ['tenant-management'],
      allowedActorRoles: ['platform_admin', 'system'],
      payloadSchemas: { 1: TenantOnboardedPayloadV1 },
      async apply(payload, { client, envelope }) {
        if (tenantOf(envelope.tenantId) !== payload.tenantId) throw new PermanentMessageError('TENANT_MISMATCH', 'tenant mismatch');
        await new PgCatalogRepository(client).upsertTenantReplica({ ...payload, id: payload.tenantId, version: payload.aggregateVersion });
      },
    }),
    eventHandler(runtime, QUEUES.replicas, {
      messageType: 'TenantUserDeactivated',
      allowedProducers: ['user-management'],
      allowedActorRoles: ['clinic_admin', 'system'],
      payloadSchemas: { 1: TenantUserDeactivatedPayloadV1 },
      async apply(payload, context) {
        tenantOf(context.envelope.tenantId);
        await deactivateProfessionalOfUser(new PgCatalogRepository(context.client), context, payload.userId);
      },
    }),
  ];

  return {
    [QUEUES.commands]: commands as readonly MessageHandler<unknown>[],
    [QUEUES.replicas]: replicas as readonly MessageHandler<unknown>[],
  };
}
