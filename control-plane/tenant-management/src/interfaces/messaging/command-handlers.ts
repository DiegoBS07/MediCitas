import { z } from 'zod';
import {
  PermanentMessageError,
  commandHandler,
  type HandlerRuntime,
  type MessageEffectContext,
  type MessageHandler,
} from '@medicitas/messaging';
import { activateTenant, createTenant, markTenantOnboardingFailed } from '../../application/commands/tenant-commands.js';
import { PgTenantRepository } from '../../infrastructure/persistence/pg-tenant-repository.js';

export const COMMANDS_QUEUE = 'tenant-management.commands';

/** Payload schemas v1 (messaging-contracts §6). Unknown payload fields are ignored (§9.2). */
export const CreateTenantPayloadV1 = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(64),
  timezone: z.string().min(1).max(64),
});

export const ActivateTenantPayloadV1 = z.object({
  tenantId: z.uuid(),
  firstAdmin: z.object({
    subject: z.uuid(),
    email: z.email().max(254),
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
  }),
});

export const MarkTenantOnboardingFailedPayloadV1 = z.object({
  tenantId: z.uuid(),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
});

/** The envelope tenant must be the tenant the command is about (no cross-tenant commands). */
function assertEnvelopeTenant(context: MessageEffectContext, tenantId: string): void {
  if (context.envelope.tenantId !== tenantId) {
    throw new PermanentMessageError('TENANT_MISMATCH', 'envelope tenantId differs from payload tenantId');
  }
}

export function tenantCommandHandlers(runtime: HandlerRuntime): readonly MessageHandler<unknown>[] {
  const common = { allowedProducers: ['onboarding-orchestrator'], allowedActorRoles: ['platform_admin'] } as const;

  const create = commandHandler(runtime, COMMANDS_QUEUE, {
    ...common,
    messageType: 'CreateTenantCommand',
    replyType: 'TenantCreatedReply',
    payloadSchemas: { 1: CreateTenantPayloadV1 },
    async execute(payload, context) {
      if (context.envelope.tenantId !== null) {
        throw new PermanentMessageError('TENANT_NOT_EXPECTED', 'CreateTenantCommand must not carry a tenantId');
      }
      if (context.envelope.sagaId === null) throw new PermanentMessageError('SAGA_REQUIRED', 'sagaId is required');
      const tenant = await createTenant(new PgTenantRepository(context.client), {
        ...payload,
        onboardingSagaId: context.envelope.sagaId,
      });
      return { tenantId: tenant.id, status: tenant.status };
    },
  });

  const activate = commandHandler(runtime, COMMANDS_QUEUE, {
    ...common,
    messageType: 'ActivateTenantCommand',
    replyType: 'TenantActivatedReply',
    payloadSchemas: { 1: ActivateTenantPayloadV1 },
    async execute(payload, context) {
      assertEnvelopeTenant(context, payload.tenantId);
      const tenant = await activateTenant(new PgTenantRepository(context.client), context, payload);
      return { tenantId: tenant.id, status: tenant.status };
    },
  });

  const markFailed = commandHandler(runtime, COMMANDS_QUEUE, {
    ...common,
    messageType: 'MarkTenantOnboardingFailedCommand',
    replyType: 'TenantOnboardingFailedReply',
    payloadSchemas: { 1: MarkTenantOnboardingFailedPayloadV1 },
    async execute(payload, context) {
      assertEnvelopeTenant(context, payload.tenantId);
      const tenant = await markTenantOnboardingFailed(new PgTenantRepository(context.client), context, payload);
      return { tenantId: tenant.id, status: tenant.status };
    },
  });

  return [create, activate, markFailed] as readonly MessageHandler<unknown>[];
}
