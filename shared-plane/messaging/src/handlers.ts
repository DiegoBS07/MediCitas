import type { z } from 'zod';
import {
  isAppError,
  isUuid,
  withTransaction,
  type AppError,
  type DatabaseClient,
  type DatabasePool,
  type IsolationLevel,
} from '@medicitas/kernel';
import type { Logger } from '@medicitas/observability';
import type { InboundMessage, MessageHandler } from './consumer.js';
import { createEnvelope, createReply, type ActorRole, type Envelope, type ReplyPayload } from './envelope.js';
import { PermanentMessageError } from './errors.js';
import { claimInbox, storeInboxReply } from './inbox.js';
import { enqueueOutbox } from './outbox.js';
import type { Publisher } from './publisher.js';
import { respondToQuery } from './query.js';
import { EXCHANGES, SERVICE_NAMES, type ServiceName } from './topology.js';

/**
 * Generic consumers for the three message kinds (messaging-contracts §4–§8). They implement the
 * consumer pipeline once, so services only write the domain effect:
 *
 *   command  → BEGIN; inbox; SAVEPOINT; effect; reply (+ events) to the outbox; COMMIT; ACK
 *   event    → BEGIN; inbox; effect; COMMIT; ACK
 *   query    → read-only transaction; reply through direct reply-to; ACK
 *
 * A business rejection (an AppError that is not transient) rolls back to the savepoint, so the
 * effects disappear while the inbox row and the `rejected` reply still commit.
 */
export interface HandlerRuntime {
  readonly service: ServiceName;
  readonly pool: DatabasePool;
  readonly publisher: Publisher;
  readonly logger: Logger;
  /** <prefix>_system: the DB role used by message consumers (ADR-0009). */
  readonly systemDbRole: string;
}

export interface EventToEmit {
  readonly messageType: string;
  readonly routingKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly messageVersion?: number;
  /** Defaults to the tenant of the message being processed. */
  readonly tenantId?: string | null;
}

export interface MessageEffectContext {
  readonly client: DatabaseClient;
  readonly envelope: Envelope;
  /** Enqueues a domain event in the current transaction (it disappears if the effect is rejected). */
  emit(event: EventToEmit): Promise<Envelope>;
}

interface CommonDefinition<P> {
  readonly messageType: string;
  readonly payloadSchemas: Readonly<Record<number, z.ZodType<P>>>;
  readonly allowedProducers: readonly ServiceName[];
  readonly allowedActorRoles: readonly ActorRole[];
  readonly isolation?: IsolationLevel;
}

export interface CommandDefinition<P> extends CommonDefinition<P> {
  readonly replyType: string;
  /** Applies the command; returns the reply `result`. Throw a non-transient AppError to reject. */
  execute(payload: P, context: MessageEffectContext): Promise<Readonly<Record<string, unknown>>>;
}

export interface EventDefinition<P> extends CommonDefinition<P> {
  apply(payload: P, context: MessageEffectContext): Promise<void>;
}

export interface QueryDefinition<P> extends CommonDefinition<P> {
  readonly resultType: string;
  execute(payload: P, context: { readonly client: DatabaseClient; readonly envelope: Envelope }): Promise<
    Readonly<Record<string, unknown>>
  >;
}

/** True for errors that are a business decision (reply `rejected`) rather than a processing failure. */
export function isBusinessRejection(error: unknown): error is AppError {
  return (
    isAppError(error) &&
    !error.retryable &&
    (error.category === 'validation' ||
      error.category === 'not_found' ||
      error.category === 'conflict' ||
      error.category === 'business_rule' ||
      error.category === 'authorization')
  );
}

/** Actor subject usable as app.actor_subject (system actors such as "system:x" become NULL). */
export function actorSubjectOf(envelope: Envelope): string | null {
  return isUuid(envelope.actor.subject) ? envelope.actor.subject : null;
}

function effectContext(runtime: HandlerRuntime, client: DatabaseClient, envelope: Envelope): MessageEffectContext {
  return {
    client,
    envelope,
    async emit(event) {
      const eventEnvelope = createEnvelope({
        messageType: event.messageType,
        ...(event.messageVersion === undefined ? {} : { messageVersion: event.messageVersion }),
        producer: runtime.service,
        tenantId: event.tenantId === undefined ? envelope.tenantId : event.tenantId,
        actor: envelope.actor,
        correlationId: envelope.correlationId,
        causationId: envelope.messageId,
        sagaId: envelope.sagaId,
        payload: event.payload,
      });
      await enqueueOutbox(client, { exchange: EXCHANGES.events, routingKey: event.routingKey, envelope: eventEnvelope });
      return eventEnvelope;
    },
  };
}

function replyRoutingKey(envelope: Envelope): string | null {
  if (envelope.replyTo === null) return null;
  // Replies go back to the broker-verified producer only: a command cannot redirect replies elsewhere.
  if (envelope.replyTo !== envelope.producer || !(SERVICE_NAMES as readonly string[]).includes(envelope.replyTo)) {
    throw new PermanentMessageError('INVALID_REPLY_TO', 'replyTo must name the producing service');
  }
  return envelope.replyTo;
}

function rejectionPayload(error: AppError): ReplyPayload {
  return {
    outcome: 'rejected',
    result: Object.keys(error.meta).length === 0 ? null : { ...error.meta },
    error: { code: error.code, message: error.message.slice(0, 500), retryable: false },
  };
}

export function commandHandler<P>(runtime: HandlerRuntime, queue: string, definition: CommandDefinition<P>): MessageHandler<P> {
  return {
    messageType: definition.messageType,
    payloadSchemas: definition.payloadSchemas,
    allowedProducers: definition.allowedProducers,
    allowedActorRoles: definition.allowedActorRoles,

    async handle(message: InboundMessage<P>): Promise<void> {
      const { envelope } = message;
      const routingKey = replyRoutingKey(envelope);
      let duplicateReply: Envelope | null = null;
      let duplicate = false;

      await withTransaction(
        runtime.pool,
        {
          tenantId: envelope.tenantId,
          actorSubject: actorSubjectOf(envelope),
          dbRole: runtime.systemDbRole,
          isolation: definition.isolation ?? 'READ COMMITTED',
        },
        async (client) => {
          duplicate = false;
          duplicateReply = null;
          const claim = await claimInbox(client, queue, envelope);
          if (claim.duplicate) {
            duplicate = true;
            duplicateReply = claim.storedReply;
            return;
          }
          await client.query('SAVEPOINT command_effects');
          let payload: ReplyPayload;
          try {
            const result = await definition.execute(message.payload, effectContext(runtime, client, envelope));
            payload = { outcome: 'succeeded', result: { ...result }, error: null };
          } catch (error) {
            if (!isBusinessRejection(error)) throw error;
            await client.query('ROLLBACK TO SAVEPOINT command_effects');
            payload = rejectionPayload(error);
            runtime.logger.info({ messageType: envelope.messageType, code: error.code }, 'command rejected');
          }
          if (routingKey !== null) {
            const reply = createReply(envelope, { messageType: definition.replyType, producer: runtime.service, payload });
            await enqueueOutbox(client, { exchange: EXCHANGES.replies, routingKey, envelope: reply });
            await storeInboxReply(client, queue, envelope.messageId, reply);
          }
        },
      );

      if (duplicate) {
        runtime.logger.info({ messageType: envelope.messageType }, 'duplicate command; re-publishing stored reply');
        if (duplicateReply !== null && routingKey !== null) {
          await runtime.publisher.publish(EXCHANGES.replies, routingKey, duplicateReply);
        }
      }
    },

    async onExhausted(message: InboundMessage<P>, error: unknown): Promise<void> {
      let routingKey: string | null;
      try {
        routingKey = replyRoutingKey(message.envelope);
      } catch {
        return;
      }
      if (routingKey === null) return;
      const reply = createReply(message.envelope, {
        messageType: definition.replyType,
        producer: runtime.service,
        payload: {
          outcome: 'failed',
          result: null,
          error: {
            code: isAppError(error) ? error.code : 'PROCESSING_FAILED',
            message: 'The command could not be processed after retries.',
            retryable: true,
          },
        },
      });
      await runtime.publisher.publish(EXCHANGES.replies, routingKey, reply);
    },
  };
}

export function eventHandler<P>(runtime: HandlerRuntime, queue: string, definition: EventDefinition<P>): MessageHandler<P> {
  return {
    messageType: definition.messageType,
    payloadSchemas: definition.payloadSchemas,
    allowedProducers: definition.allowedProducers,
    allowedActorRoles: definition.allowedActorRoles,
    async handle(message: InboundMessage<P>): Promise<void> {
      const { envelope } = message;
      await withTransaction(
        runtime.pool,
        {
          tenantId: envelope.tenantId,
          actorSubject: actorSubjectOf(envelope),
          dbRole: runtime.systemDbRole,
          isolation: definition.isolation ?? 'READ COMMITTED',
        },
        async (client) => {
          const claim = await claimInbox(client, queue, envelope);
          if (claim.duplicate) return;
          await definition.apply(message.payload, effectContext(runtime, client, envelope));
        },
      );
    },
  };
}

export function queryHandler<P>(runtime: HandlerRuntime, definition: QueryDefinition<P>): MessageHandler<P> {
  return {
    messageType: definition.messageType,
    payloadSchemas: definition.payloadSchemas,
    allowedProducers: definition.allowedProducers,
    allowedActorRoles: definition.allowedActorRoles,
    async handle(message: InboundMessage<P>): Promise<void> {
      const { envelope } = message;
      let payload: ReplyPayload;
      try {
        const result = await withTransaction(
          runtime.pool,
          {
            tenantId: envelope.tenantId,
            actorSubject: actorSubjectOf(envelope),
            dbRole: runtime.systemDbRole,
            isolation: 'READ COMMITTED',
            readOnly: true,
          },
          (client) => definition.execute(message.payload, { client, envelope }),
        );
        payload = { outcome: 'succeeded', result: { ...result }, error: null };
      } catch (error) {
        if (!isBusinessRejection(error)) throw error;
        payload = rejectionPayload(error);
      }
      const reply = createReply(envelope, { messageType: definition.resultType, producer: runtime.service, payload });
      await respondToQuery(runtime.publisher, message as InboundMessage<unknown>, reply);
    },
  };
}

/** Builds a domain event envelope for an HTTP-originated change (actor taken from the request context). */
export async function enqueueDomainEvent(
  client: DatabaseClient,
  event: EventToEmit & {
    readonly producer: ServiceName;
    readonly tenantId: string | null;
    readonly actor: { readonly subject: string; readonly roles: readonly ActorRole[] };
    readonly correlationId: string;
  },
): Promise<Envelope> {
  const envelope = createEnvelope({
    messageType: event.messageType,
    ...(event.messageVersion === undefined ? {} : { messageVersion: event.messageVersion }),
    producer: event.producer,
    tenantId: event.tenantId,
    actor: { subject: event.actor.subject, roles: [...event.actor.roles] },
    correlationId: event.correlationId,
    payload: event.payload,
  });
  await enqueueOutbox(client, { exchange: EXCHANGES.events, routingKey: event.routingKey, envelope });
  return envelope;
}

/** Port used by application code to announce domain events (implemented over the outbox). */
export interface EventSink {
  emit(event: EventToEmit): Promise<unknown>;
}

/** EventSink for HTTP-originated transactions: the actor and correlation come from the request. */
export function requestEventSink(
  client: DatabaseClient,
  origin: {
    readonly producer: ServiceName;
    readonly tenantId: string | null;
    readonly actor: { readonly subject: string; readonly roles: readonly ActorRole[] };
    readonly correlationId: string;
  },
): EventSink {
  return {
    emit: (event) =>
      enqueueDomainEvent(client, {
        ...event,
        producer: origin.producer,
        tenantId: event.tenantId === undefined ? origin.tenantId : event.tenantId,
        actor: origin.actor,
        correlationId: origin.correlationId,
      }),
  };
}
