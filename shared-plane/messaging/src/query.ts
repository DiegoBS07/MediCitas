import type { ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import type { z } from 'zod';
import { DependencyUnavailableError } from '@medicitas/kernel';
import type { AmqpConnectionManager } from './connection.js';
import { EnvelopeSchema, type Envelope } from './envelope.js';
import type { InboundMessage } from './consumer.js';
import type { Publisher } from './publisher.js';
import { DEFAULT_EXCHANGE, DIRECT_REPLY_TO, EXCHANGES } from './topology.js';

interface PendingQuery {
  readonly resolve: (reply: Envelope) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/**
 * Synchronous query over RabbitMQ direct reply-to (ADR-0003): the reply must reach the exact
 * process that holds the HTTP request. A timeout becomes 503 — it never means "not found".
 */
export class QueryClient {
  private readonly channel: ChannelWrapper;
  private readonly pending = new Map<string, PendingQuery>();

  constructor(
    connection: AmqpConnectionManager,
    private readonly config: { readonly brokerUser: string; readonly timeoutMs?: number },
  ) {
    this.channel = connection.createChannel({
      name: `query-client:${config.brokerUser}`,
      confirm: true,
      json: false,
      setup: async (channel: ConfirmChannel) => {
        await channel.consume(DIRECT_REPLY_TO, (message) => this.onReply(message), { noAck: true });
      },
    });
  }

  async request<R>(routingKey: string, query: Envelope, resultSchema: z.ZodType<R>): Promise<R> {
    await this.channel.waitForConnect();
    const replyPromise = new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(query.messageId);
        reject(new DependencyUnavailableError(`query ${query.messageType}`));
      }, this.config.timeoutMs ?? 3_000);
      this.pending.set(query.messageId, { resolve, reject, timer });
    });
    try {
      await this.channel.publish(EXCHANGES.queries, routingKey, Buffer.from(JSON.stringify(query), 'utf8'), {
        persistent: false,
        contentType: 'application/json',
        contentEncoding: 'utf-8',
        userId: this.config.brokerUser,
        messageId: query.messageId,
        correlationId: query.messageId,
        type: query.messageType,
        appId: query.producer,
        replyTo: DIRECT_REPLY_TO,
        headers: { 'x-message-version': query.messageVersion },
      });
    } catch (error) {
      const entry = this.pending.get(query.messageId);
      if (entry !== undefined) {
        clearTimeout(entry.timer);
        this.pending.delete(query.messageId);
      }
      throw new DependencyUnavailableError(`query ${query.messageType}`, error);
    }
    const reply = await replyPromise;
    return resultSchema.parse(reply.payload);
  }

  async close(): Promise<void> {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new DependencyUnavailableError('query client closed'));
      this.pending.delete(id);
    }
    await this.channel.close();
  }

  private onReply(message: ConsumeMessage | null): void {
    if (message === null) return;
    const correlationId = message.properties.correlationId === undefined ? '' : String(message.properties.correlationId);
    const entry = this.pending.get(correlationId);
    if (entry === undefined) return; // late reply after timeout: ignored
    clearTimeout(entry.timer);
    this.pending.delete(correlationId);
    const parsed = EnvelopeSchema.safeParse(safeJson(message.content));
    if (parsed.success) entry.resolve(parsed.data);
    else entry.reject(new DependencyUnavailableError('query reply malformed'));
  }
}

function safeJson(content: Buffer): unknown {
  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Responder side: answer a query received by a Consumer handler through the default exchange. */
export async function respondToQuery(publisher: Publisher, query: InboundMessage<unknown>, reply: Envelope): Promise<void> {
  if (query.replyToProperty === undefined || query.correlationIdProperty === undefined) return;
  await publisher.publish(DEFAULT_EXCHANGE, query.replyToProperty, reply, {
    correlationIdProperty: query.correlationIdProperty,
  });
}
