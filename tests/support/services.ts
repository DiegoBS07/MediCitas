import { randomUUID } from 'node:crypto';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import {
  EXCHANGES,
  EnvelopeSchema,
  Publisher,
  createEnvelope,
  serviceDefinition,
  type AmqpConnectionManager,
  type Envelope,
  type NewEnvelope,
  type ServiceName,
} from '@medicitas/messaging';
import { adminConnection, serviceConnection } from './broker.js';
import { waitFor } from './env.js';

/**
 * Collects copies of the messages routed to `exchange` with `routingKey` through an exclusive
 * temporary queue (the real consumer queues keep receiving their own copies).
 */
export class MessageTap {
  readonly messages: Envelope[] = [];
  private readonly connection: AmqpConnectionManager;
  private readonly queue = `test.tap.${randomUUID().slice(0, 8)}`;

  private constructor(private readonly bindings: readonly { readonly exchange: string; readonly routingKey: string }[]) {
    this.connection = adminConnection(`tests:tap:${this.queue}`);
  }

  static async open(bindings: readonly { readonly exchange: string; readonly routingKey: string }[]): Promise<MessageTap> {
    const tap = new MessageTap(bindings);
    const channel = tap.connection.createChannel({
      json: false,
      setup: async (ch: ConfirmChannel) => {
        await ch.assertQueue(tap.queue, { exclusive: true, autoDelete: true, durable: false });
        for (const binding of tap.bindings) await ch.bindQueue(tap.queue, binding.exchange, binding.routingKey);
        await ch.consume(tap.queue, (message: ConsumeMessage | null) => {
          if (message === null) return;
          const parsed = EnvelopeSchema.safeParse(JSON.parse(message.content.toString('utf8')));
          if (parsed.success) tap.messages.push(parsed.data);
          ch.ack(message);
        });
      },
    });
    await channel.waitForConnect();
    return tap;
  }

  async waitFor(predicate: (message: Envelope) => boolean, timeoutMs = 10_000): Promise<Envelope> {
    await waitFor(() => this.messages.some(predicate), timeoutMs);
    return this.messages.find(predicate) as Envelope;
  }

  async close(): Promise<void> {
    await this.connection.close();
  }
}

/** Sends messages with the real broker identity of a producing service (user_id validated by RabbitMQ). */
export class ServiceProbe {
  private readonly connection: AmqpConnectionManager;
  private readonly publisher: Publisher;

  constructor(readonly service: ServiceName) {
    this.connection = serviceConnection(service);
    this.publisher = new Publisher(this.connection, { brokerUser: serviceDefinition(service).brokerUser });
  }

  async ready(): Promise<void> {
    await this.publisher.waitForConnect();
  }

  envelope(input: Omit<NewEnvelope, 'producer' | 'correlationId'> & { readonly correlationId?: string }): Envelope {
    return createEnvelope({ ...input, producer: this.service, correlationId: input.correlationId ?? randomUUID() });
  }

  async command(routingKey: string, envelope: Envelope): Promise<void> {
    await this.publisher.publish(EXCHANGES.commands, routingKey, envelope);
  }

  async event(routingKey: string, envelope: Envelope): Promise<void> {
    await this.publisher.publish(EXCHANGES.events, routingKey, envelope);
  }

  async close(): Promise<void> {
    await this.publisher.close();
    await this.connection.close();
  }
}
