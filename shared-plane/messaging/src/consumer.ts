import type { ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { z } from 'zod';
import type { Logger } from '@medicitas/observability';
import { runWithLogContext } from '@medicitas/observability';
import { isConnectionError } from '@medicitas/kernel';
import type { AmqpConnectionManager } from './connection.js';
import { EnvelopeSchema, type ActorRole, type Envelope } from './envelope.js';
import { PermanentMessageError, TransientMessageError } from './errors.js';
import {
  DEFAULT_RETRY_TIERS_MS,
  EXCHANGES,
  retryExchangeOf,
  retryQueueName,
  serviceDefinition,
  serviceOfBrokerUser,
  type ServiceName,
} from './topology.js';

export interface InboundMessage<P> {
  readonly envelope: Envelope;
  readonly payload: P;
  readonly queue: string;
  /** 1 for the first delivery, then 2..N+1 for each delayed retry. */
  readonly deliveryAttempt: number;
  /** AMQP properties needed by query responders (direct reply-to). */
  readonly replyToProperty: string | undefined;
  readonly correlationIdProperty: string | undefined;
}

export interface MessageHandler<P> {
  readonly messageType: string;
  /** Payload schema per supported messageVersion; unknown versions go to the DLQ. */
  readonly payloadSchemas: Readonly<Record<number, z.ZodType<P>>>;
  /** Services allowed to produce this message (checked against the broker-validated user_id). */
  readonly allowedProducers: readonly ServiceName[];
  readonly allowedActorRoles: readonly ActorRole[];
  /** Must commit its effects (and inbox row) before resolving: the ACK follows the resolution. */
  handle(message: InboundMessage<P>): Promise<void>;
  /** Called when the message is dead-lettered after retries, e.g. to send a `failed` reply. */
  onExhausted?(message: InboundMessage<P>, error: unknown): Promise<void>;
}

export interface ConsumerConfig {
  readonly queue: string;
  readonly prefetch: number;
  /** Broker user of this connection (used to recognise own retries). */
  readonly brokerUser: string;
  readonly retryExchange: string;
  readonly retryTiersMs?: readonly number[];
  readonly handlers: readonly MessageHandler<unknown>[];
  /** Maps a broker user to a producing service; defaults to the topology mapping. */
  readonly resolveProducer?: (brokerUser: string | undefined) => ServiceName | undefined;
}

/** Consumer configuration for one queue of a service, derived from the topology. */
export function consumerConfigFor(
  service: ServiceName,
  queue: string,
  handlers: readonly MessageHandler<unknown>[],
): ConsumerConfig {
  const definition = serviceDefinition(service);
  const queueDefinition = definition.consumes.find((candidate) => candidate.name === queue);
  if (queueDefinition === undefined) throw new Error(`Queue ${queue} is not consumed by ${service}`);
  return {
    queue,
    prefetch: queueDefinition.prefetch,
    brokerUser: definition.brokerUser,
    retryExchange: retryExchangeOf(service),
    retryTiersMs: queueDefinition.retryTiersMs ?? DEFAULT_RETRY_TIERS_MS,
    handlers,
  };
}

const HEADER_RETRY_COUNT = 'x-retry-count';
const HEADER_ORIGINAL_USER = 'x-original-user-id';
const HEADER_FIRST_FAILURE = 'x-first-failure-at';
const HEADER_LAST_ERROR = 'x-last-error-code';
const HEADER_DEAD_LETTER_REASON = 'x-dead-letter-reason';

/**
 * Manual-ack consumer implementing the reliable consumption pipeline:
 * envelope → producer allowlist (broker-validated user_id) → actor allowlist → payload version
 * → handler → ACK. Failures: permanent → DLQ; otherwise delayed retry tiers, then DLQ.
 * Never uses nack-with-requeue for retries (no hot loops).
 */
export class Consumer {
  private readonly channel: ChannelWrapper;
  private readonly handlers: ReadonlyMap<string, MessageHandler<unknown>>;
  private readonly tiers: number;
  private readonly resolveProducer: (brokerUser: string | undefined) => ServiceName | undefined;

  constructor(
    connection: AmqpConnectionManager,
    private readonly config: ConsumerConfig,
    private readonly logger: Logger,
  ) {
    this.handlers = new Map(config.handlers.map((handler) => [handler.messageType, handler]));
    this.tiers = (config.retryTiersMs ?? DEFAULT_RETRY_TIERS_MS).length;
    this.resolveProducer = config.resolveProducer ?? serviceOfBrokerUser;
    this.channel = connection.createChannel({
      name: `consumer:${config.queue}`,
      confirm: true,
      json: false,
      // The queue is declared by the broker bootstrap; services only check it (no configure permission).
      setup: async (channel: ConfirmChannel) => {
        await channel.checkQueue(config.queue);
      },
    });
  }

  async start(): Promise<void> {
    await this.channel.consume(
      this.config.queue,
      (message) => {
        void this.process(message);
      },
      { noAck: false, prefetch: this.config.prefetch },
    );
    this.logger.info({ queue: this.config.queue }, 'consumer started');
  }

  async stop(): Promise<void> {
    await this.channel.cancelAll();
    await this.channel.close();
  }

  private async process(message: ConsumeMessage): Promise<void> {
    const headers = message.properties.headers ?? {};
    const retryCount = Number.isInteger(headers[HEADER_RETRY_COUNT]) ? Number(headers[HEADER_RETRY_COUNT]) : 0;
    const deliveryAttempt = retryCount + 1;
    const brokerUser = typeof message.properties.userId === 'string' ? message.properties.userId : undefined;
    // A message coming back from our own retry tiers carries the original producer in a header.
    // Only trusted when the retry was published by this very service (per-service retry exchange).
    const originalUser =
      brokerUser === this.config.brokerUser && typeof headers[HEADER_ORIGINAL_USER] === 'string'
        ? String(headers[HEADER_ORIGINAL_USER])
        : brokerUser;

    let envelope: Envelope;
    try {
      envelope = EnvelopeSchema.parse(JSON.parse(message.content.toString('utf8')));
    } catch {
      await this.deadLetter(message, 'INVALID_ENVELOPE', originalUser, retryCount);
      return;
    }

    await runWithLogContext(
      {
        correlationId: envelope.correlationId,
        causationId: envelope.causationId,
        messageId: envelope.messageId,
        ...(envelope.sagaId === null ? {} : { sagaId: envelope.sagaId }),
        ...(envelope.tenantId === null ? {} : { tenantId: envelope.tenantId }),
      },
      () => this.dispatch(message, envelope, originalUser, deliveryAttempt, retryCount),
    );
  }

  private async dispatch(
    message: ConsumeMessage,
    envelope: Envelope,
    producerUser: string | undefined,
    deliveryAttempt: number,
    retryCount: number,
  ): Promise<void> {
    const handler = this.handlers.get(envelope.messageType);
    if (handler === undefined) {
      await this.deadLetter(message, 'UNKNOWN_MESSAGE_TYPE', producerUser, retryCount);
      return;
    }
    const producer = this.resolveProducer(producerUser);
    if (producer === undefined || producer !== envelope.producer || !handler.allowedProducers.includes(producer)) {
      this.logger.warn({ messageType: envelope.messageType, producer: envelope.producer }, 'producer not allowed');
      await this.deadLetter(message, 'PRODUCER_NOT_ALLOWED', producerUser, retryCount);
      return;
    }
    if (!envelope.actor.roles.some((role) => handler.allowedActorRoles.includes(role))) {
      this.logger.warn({ messageType: envelope.messageType }, 'actor role not allowed');
      await this.deadLetter(message, 'ACTOR_NOT_ALLOWED', producerUser, retryCount);
      return;
    }
    const schema = handler.payloadSchemas[envelope.messageVersion];
    if (schema === undefined) {
      await this.deadLetter(message, 'UNSUPPORTED_VERSION', producerUser, retryCount);
      return;
    }
    const parsedPayload = schema.safeParse(envelope.payload);
    if (!parsedPayload.success) {
      await this.deadLetter(message, 'INVALID_PAYLOAD', producerUser, retryCount);
      return;
    }

    const inbound: InboundMessage<unknown> = {
      envelope,
      payload: parsedPayload.data,
      queue: this.config.queue,
      deliveryAttempt,
      replyToProperty: message.properties.replyTo === undefined ? undefined : String(message.properties.replyTo),
      correlationIdProperty:
        message.properties.correlationId === undefined ? undefined : String(message.properties.correlationId),
    };

    try {
      await handler.handle(inbound);
      this.channel.ack(message);
    } catch (error) {
      await this.handleFailure(message, handler, inbound, error, producerUser, retryCount);
    }
  }

  private async handleFailure(
    message: ConsumeMessage,
    handler: MessageHandler<unknown>,
    inbound: InboundMessage<unknown>,
    error: unknown,
    producerUser: string | undefined,
    retryCount: number,
  ): Promise<void> {
    const reasonCode =
      error instanceof PermanentMessageError || error instanceof TransientMessageError
        ? error.reasonCode
        : isConnectionError(error)
          ? 'DEPENDENCY_UNAVAILABLE'
          : 'PROCESSING_ERROR';
    const permanent = error instanceof PermanentMessageError;

    if (!permanent && inbound.deliveryAttempt <= this.tiers) {
      this.logger.warn(
        { messageType: inbound.envelope.messageType, attempt: inbound.deliveryAttempt, reasonCode },
        'message processing failed; scheduling delayed retry',
      );
      const firstFailure = message.properties.headers?.[HEADER_FIRST_FAILURE];
      await this.republishAndAck(message, this.config.retryExchange, retryQueueName(this.config.queue, inbound.deliveryAttempt), {
        [HEADER_RETRY_COUNT]: retryCount + 1,
        [HEADER_ORIGINAL_USER]: producerUser ?? '',
        [HEADER_FIRST_FAILURE]: typeof firstFailure === 'string' ? firstFailure : new Date().toISOString(),
        [HEADER_LAST_ERROR]: reasonCode,
      });
      return;
    }

    this.logger.error(
      { messageType: inbound.envelope.messageType, attempt: inbound.deliveryAttempt, reasonCode },
      permanent ? 'permanent message failure; dead-lettering' : 'retries exhausted; dead-lettering',
    );
    await this.deadLetter(message, permanent ? reasonCode : 'RETRIES_EXHAUSTED', producerUser, retryCount);
    if (handler.onExhausted !== undefined) {
      try {
        await handler.onExhausted(inbound, error);
      } catch (callbackError) {
        this.logger.error({ err: errorMessage(callbackError) }, 'onExhausted callback failed');
      }
    }
  }

  private async deadLetter(
    message: ConsumeMessage,
    reason: string,
    producerUser: string | undefined,
    retryCount: number,
  ): Promise<void> {
    await this.republishAndAck(message, EXCHANGES.deadLetter, this.config.queue, {
      [HEADER_DEAD_LETTER_REASON]: reason,
      [HEADER_RETRY_COUNT]: retryCount,
      [HEADER_ORIGINAL_USER]: producerUser ?? '',
    });
  }

  /**
   * Publishes a copy (confirmed by the broker) and only then ACKs the original. If the copy
   * cannot be published, the delivery is returned to the queue after a pause instead of being lost.
   */
  private async republishAndAck(
    message: ConsumeMessage,
    exchange: string,
    routingKey: string,
    extraHeaders: Readonly<Record<string, string | number>>,
  ): Promise<void> {
    const properties = message.properties;
    try {
      await this.channel.publish(exchange, routingKey, message.content, {
        persistent: true,
        contentType: 'application/json',
        contentEncoding: 'utf-8',
        userId: this.config.brokerUser,
        ...(properties.messageId === undefined ? {} : { messageId: String(properties.messageId) }),
        ...(properties.correlationId === undefined ? {} : { correlationId: String(properties.correlationId) }),
        ...(properties.type === undefined ? {} : { type: String(properties.type) }),
        ...(properties.appId === undefined ? {} : { appId: String(properties.appId) }),
        ...(properties.replyTo === undefined ? {} : { replyTo: String(properties.replyTo) }),
        headers: { ...properties.headers, ...extraHeaders },
      });
      this.channel.ack(message);
    } catch (error) {
      this.logger.error({ err: errorMessage(error), exchange }, 'republish failed; returning delivery to the queue');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      this.channel.nack(message, false, true);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
