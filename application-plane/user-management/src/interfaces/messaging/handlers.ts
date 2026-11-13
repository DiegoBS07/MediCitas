import { z } from 'zod';
import {
  PermanentMessageError,
  actorSubjectOf,
  commandHandler,
  eventHandler,
  queryHandler,
  type HandlerRuntime,
  type MessageHandler,
} from '@medicitas/messaging';
import { CLINIC_ROLES } from '../../domain/entities/user.js';
import { IDENTIFICATION_TYPES } from '../../domain/entities/patient.js';
import {
  activateReservedUser,
  applyTenantOnboarded,
  cancelUserReservation,
  changeUserRole,
  deactivateTenantUser,
  reserveUser,
} from '../../application/commands/user-commands.js';
import { ensurePatient } from '../../application/commands/patient-commands.js';
import { toUserView } from '../../application/queries/views.js';
import { PgPatientRepository, PgTenantReplicaRepository, PgUserRepository } from '../../infrastructure/persistence/pg-repositories.js';

export const QUEUES = {
  commands: 'user-management.commands',
  queries: 'user-management.queries',
  replicas: 'user-management.events.replicas',
} as const;

const name = z.string().trim().min(1).max(80);

/** Payload schemas v1 (messaging-contracts §6–§8). */
export const ReserveUserPayloadV1 = z.object({
  userId: z.uuid(),
  email: z.email().max(254),
  firstName: name,
  lastName: name,
  role: z.enum(CLINIC_ROLES),
});
export const ActivateUserPayloadV1 = z.object({ userId: z.uuid(), keycloakSubject: z.uuid() });
export const CancelUserReservationPayloadV1 = z.object({ userId: z.uuid(), reasonCode: z.string().min(1).max(64) });
export const ChangeUserRolePayloadV1 = z.object({ userId: z.uuid(), role: z.enum(CLINIC_ROLES) });
export const DeactivateUserPayloadV1 = z.object({ userId: z.uuid() });

const contactSchema = z.object({
  email: z.email().max(254).nullable().optional(),
  phone: z.string().regex(/^\+?[0-9 ()-]{7,20}$/).nullable().optional(),
  address: z.string().max(300).nullable().optional(),
});
export const NewPatientSchema = z.object({
  identificationType: z.enum(IDENTIFICATION_TYPES),
  identificationNumber: z.string().regex(/^[A-Za-z0-9-]{3,30}$/),
  firstName: name,
  lastName: name,
  birthDate: z.iso.date(),
  contact: contactSchema.default({}),
});
export const EnsurePatientPayloadV1 = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('existing'), patientId: z.uuid() }),
  z.object({ mode: z.literal('create'), patientId: z.uuid(), patient: NewPatientSchema }),
]);
export const GetTenantUserPayloadV1 = z.object({ userId: z.uuid() });
export const TenantOnboardedPayloadV1 = z.object({
  tenantId: z.uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  timezone: z.string().min(1),
  status: z.literal('active'),
  aggregateVersion: z.number().int().min(1),
  firstAdmin: z.object({ subject: z.uuid(), email: z.email(), firstName: z.string().min(1), lastName: z.string().min(1) }),
});

function requireTenant(tenantId: string | null): string {
  if (tenantId === null) throw new PermanentMessageError('TENANT_REQUIRED', 'tenant-scoped message without tenantId');
  return tenantId;
}

export function userManagementHandlers(runtime: HandlerRuntime): Readonly<Record<string, readonly MessageHandler<unknown>[]>> {
  const provisioning = { allowedProducers: ['user-management-orchestrator'], allowedActorRoles: ['clinic_admin'] } as const;
  const q = QUEUES.commands;

  const commands = [
    commandHandler(runtime, q, {
      ...provisioning,
      messageType: 'ReserveUserCommand',
      replyType: 'UserReservedReply',
      payloadSchemas: { 1: ReserveUserPayloadV1 },
      async execute(payload, { client, envelope }) {
        const user = await reserveUser(new PgUserRepository(client), {
          ...payload,
          tenantId: requireTenant(envelope.tenantId),
          sagaId: envelope.sagaId,
        });
        return { userId: user.id, status: user.status };
      },
    }),
    commandHandler(runtime, q, {
      ...provisioning,
      messageType: 'ActivateUserCommand',
      replyType: 'UserActivatedReply',
      payloadSchemas: { 1: ActivateUserPayloadV1 },
      async execute(payload, context) {
        requireTenant(context.envelope.tenantId);
        return toUserView(await activateReservedUser(new PgUserRepository(context.client), context, payload));
      },
    }),
    commandHandler(runtime, q, {
      ...provisioning,
      messageType: 'CancelUserReservationCommand',
      replyType: 'UserReservationCancelledReply',
      payloadSchemas: { 1: CancelUserReservationPayloadV1 },
      async execute(payload, { client, envelope }) {
        requireTenant(envelope.tenantId);
        const user = await cancelUserReservation(new PgUserRepository(client), payload);
        return { userId: user.id, status: user.status };
      },
    }),
    commandHandler(runtime, q, {
      ...provisioning,
      messageType: 'ChangeUserRoleCommand',
      replyType: 'UserRoleChangedReply',
      payloadSchemas: { 1: ChangeUserRolePayloadV1 },
      async execute(payload, context) {
        requireTenant(context.envelope.tenantId);
        return toUserView(await changeUserRole(new PgUserRepository(context.client), context, payload));
      },
    }),
    commandHandler(runtime, q, {
      ...provisioning,
      messageType: 'DeactivateUserCommand',
      replyType: 'UserDeactivatedReply',
      payloadSchemas: { 1: DeactivateUserPayloadV1 },
      async execute(payload, context) {
        requireTenant(context.envelope.tenantId);
        return toUserView(
          await deactivateTenantUser(new PgUserRepository(context.client), context, {
            ...payload,
            actorSubject: actorSubjectOf(context.envelope),
          }),
        );
      },
    }),
    commandHandler(runtime, q, {
      allowedProducers: ['appointment-orchestrator'],
      allowedActorRoles: ['clinic_admin', 'receptionist'],
      messageType: 'EnsurePatientCommand',
      replyType: 'PatientEnsuredReply',
      payloadSchemas: { 1: EnsurePatientPayloadV1 },
      async execute(payload, context) {
        requireTenant(context.envelope.tenantId);
        const actor = { subject: context.envelope.actor.subject, role: context.envelope.actor.roles[0] ?? 'system' };
        return ensurePatient(
          new PgPatientRepository(context.client),
          context,
          payload.mode === 'existing' ? payload : { ...payload, actor },
        );
      },
    }),
  ];

  const queries = [
    queryHandler(runtime, {
      allowedProducers: ['catalog-service-management'],
      allowedActorRoles: ['clinic_admin'],
      messageType: 'GetTenantUserQuery',
      resultType: 'TenantUserQueryResult',
      payloadSchemas: { 1: GetTenantUserPayloadV1 },
      async execute(payload, { client, envelope }) {
        requireTenant(envelope.tenantId);
        const user = await new PgUserRepository(client).findById(payload.userId);
        return user === null
          ? { found: false, user: null }
          : { found: true, user: { userId: user.id, keycloakSubject: user.keycloakSubject, role: user.role, status: user.status } };
      },
    }),
  ];

  const replicas = [
    eventHandler(runtime, QUEUES.replicas, {
      allowedProducers: ['tenant-management'],
      allowedActorRoles: ['platform_admin', 'system'],
      messageType: 'TenantOnboarded',
      payloadSchemas: { 1: TenantOnboardedPayloadV1 },
      async apply(payload, { client, envelope }) {
        if (envelope.tenantId !== payload.tenantId) {
          throw new PermanentMessageError('TENANT_MISMATCH', 'envelope tenantId differs from payload tenantId');
        }
        await applyTenantOnboarded(new PgTenantReplicaRepository(client), new PgUserRepository(client), payload);
      },
    }),
  ];

  return {
    [QUEUES.commands]: commands as readonly MessageHandler<unknown>[],
    [QUEUES.queries]: queries as readonly MessageHandler<unknown>[],
    [QUEUES.replicas]: replicas as readonly MessageHandler<unknown>[],
  };
}
