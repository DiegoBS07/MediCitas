import { z } from 'zod';
import { newId } from '@medicitas/kernel';
import { SERVICE_NAMES, type ServiceName } from './topology.js';

/** Roles that may appear as the actor of a message; `system` marks background work. */
export const ACTOR_ROLES = ['platform_admin', 'clinic_admin', 'receptionist', 'health_professional', 'system'] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];

export const ActorSchema = z
  .object({
    subject: z.string().min(1).max(255),
    roles: z.array(z.enum(ACTOR_ROLES)).min(1).max(4),
  })
  .strict();
export type Actor = z.infer<typeof ActorSchema>;

/**
 * Versioned envelope. Validated STRICTLY by every
 * consumer; the payload itself is validated by the per-type, per-version schema.
 */
export const EnvelopeSchema = z
  .object({
    messageId: z.uuid(),
    messageType: z.string().regex(/^[A-Z][A-Za-z0-9]{2,80}$/),
    messageVersion: z.number().int().min(1).max(1_000),
    occurredAt: z.iso.datetime({ offset: false }),
    producer: z.enum(SERVICE_NAMES),
    tenantId: z.uuid().nullable(),
    actor: ActorSchema,
    correlationId: z.uuid(),
    causationId: z.uuid(),
    sagaId: z.uuid().nullable(),
    commandId: z.uuid().nullable(),
    stepId: z.string().min(1).max(64).nullable(),
    replyTo: z.string().min(1).max(128).nullable(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Envelope = z.infer<typeof EnvelopeSchema>;

export interface NewEnvelope {
  readonly messageType: string;
  readonly messageVersion?: number;
  readonly producer: ServiceName;
  readonly tenantId: string | null;
  readonly actor: Actor;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly sagaId?: string | null;
  readonly commandId?: string | null;
  readonly stepId?: string | null;
  readonly replyTo?: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly messageId?: string;
}

export function createEnvelope(input: NewEnvelope): Envelope {
  return EnvelopeSchema.parse({
    messageId: input.messageId ?? newId(),
    messageType: input.messageType,
    messageVersion: input.messageVersion ?? 1,
    occurredAt: new Date().toISOString(),
    producer: input.producer,
    tenantId: input.tenantId,
    actor: input.actor,
    correlationId: input.correlationId,
    causationId: input.causationId ?? input.correlationId,
    sagaId: input.sagaId ?? null,
    commandId: input.commandId ?? null,
    stepId: input.stepId ?? null,
    replyTo: input.replyTo ?? null,
    payload: input.payload,
  });
}

export const REPLY_OUTCOMES = ['succeeded', 'rejected', 'failed'] as const;
export type ReplyOutcome = (typeof REPLY_OUTCOMES)[number];

export const ReplyPayloadSchema = z
  .object({
    outcome: z.enum(REPLY_OUTCOMES),
    result: z.record(z.string(), z.unknown()).nullable(),
    error: z
      .object({ code: z.string().min(1).max(64), message: z.string().max(500), retryable: z.boolean() })
      .strict()
      .nullable(),
  })
  .strict();
export type ReplyPayload = z.infer<typeof ReplyPayloadSchema>;

/**
 * Builds the business reply to a command: same correlation, saga and step; causation and
 * commandId point at the command. Routed to medicitas.replies with routing key = command.replyTo.
 */
export function createReply(
  command: Envelope,
  reply: { readonly messageType: string; readonly producer: ServiceName; readonly payload: ReplyPayload },
): Envelope {
  return createEnvelope({
    messageType: reply.messageType,
    producer: reply.producer,
    tenantId: command.tenantId,
    actor: command.actor,
    correlationId: command.correlationId,
    causationId: command.messageId,
    sagaId: command.sagaId,
    commandId: command.messageId,
    stepId: command.stepId,
    replyTo: null,
    payload: ReplyPayloadSchema.parse(reply.payload),
  });
}
