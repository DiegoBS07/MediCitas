import type { ChannelWrapper } from 'amqp-connection-manager';
import type { AmqpConnectionManager } from './connection.js';
import type { Envelope } from './envelope.js';

export interface PublisherConfig {
  /** Broker user of this connection; RabbitMQ validates the AMQP user_id property against it. */
  readonly brokerUser: string;
  readonly publishTimeoutMs?: number;
}

export interface PublishOptions {
  readonly headers?: Readonly<Record<string, string | number | boolean>>;
  /** Overrides the AMQP correlation-id property (direct reply-to answers). */
  readonly correlationIdProperty?: string;
  readonly replyToProperty?: string;
}

/**
 * Publishes on a CONFIRM channel. publish() resolves only after the broker's publisher confirm
 * ("the broker stored it") — a different signal from consumer ACKs and business replies.
 */
export class Publisher {
  private readonly channel: ChannelWrapper;
  private readonly config: PublisherConfig;

  constructor(connection: AmqpConnectionManager, config: PublisherConfig) {
    this.config = config;
    this.channel = connection.createChannel({
      name: `publisher:${config.brokerUser}`,
      confirm: true,
      json: false,
      publishTimeout: config.publishTimeoutMs ?? 5_000,
    });
  }

  async publish(exchange: string, routingKey: string, envelope: Envelope, options: PublishOptions = {}): Promise<void> {
    await this.publishBuffer(exchange, routingKey, Buffer.from(JSON.stringify(envelope), 'utf8'), {
      messageId: envelope.messageId,
      correlationId: options.correlationIdProperty ?? envelope.correlationId,
      type: envelope.messageType,
      appId: envelope.producer,
      headers: { 'x-message-version': envelope.messageVersion, ...options.headers },
      ...(options.replyToProperty === undefined ? {} : { replyTo: options.replyToProperty }),
    });
  }

  /** Low-level publish used for retries and dead-lettering (content preserved byte for byte). */
  async publishBuffer(
    exchange: string,
    routingKey: string,
    content: Buffer,
    properties: {
      readonly messageId?: string;
      readonly correlationId?: string;
      readonly type?: string;
      readonly appId?: string;
      readonly replyTo?: string;
      readonly headers?: Readonly<Record<string, unknown>>;
    },
  ): Promise<void> {
    await this.channel.publish(exchange, routingKey, content, {
      persistent: true,
      contentType: 'application/json',
      contentEncoding: 'utf-8',
      timestamp: Math.floor(Date.now() / 1000),
      userId: this.config.brokerUser,
      ...(properties.messageId === undefined ? {} : { messageId: properties.messageId }),
      ...(properties.correlationId === undefined ? {} : { correlationId: properties.correlationId }),
      ...(properties.type === undefined ? {} : { type: properties.type }),
      ...(properties.appId === undefined ? {} : { appId: properties.appId }),
      ...(properties.replyTo === undefined ? {} : { replyTo: properties.replyTo }),
      headers: { ...properties.headers },
    });
  }

  async waitForConnect(): Promise<void> {
    await this.channel.waitForConnect();
  }

  async close(): Promise<void> {
    await this.channel.close();
  }
}
