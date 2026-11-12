import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withTransaction } from '@medicitas/kernel';
import {
  Consumer,
  EXCHANGES,
  PermanentMessageError,
  Publisher,
  TransientMessageError,
  claimInbox,
  createEnvelope,
  createReply,
  storeInboxReply,
  type AmqpConnectionManager,
  type Envelope,
  type InboundMessage,
  type MessageHandler,
} from '@medicitas/messaging';
import { CLINIC_1, runtimePool } from '../../support/database.js';
import { adminConnection, createTempQueue, managementApi, serviceConnection, silentLogger, type TempQueue } from '../../support/broker.js';
import { env, waitFor } from '../../support/env.js';

const api = managementApi();
const Payload = z.object({ value: z.number().int() }).strict();
type Payload = z.infer<typeof Payload>;

let schedulerConnection: AmqpConnectionManager;
let adminConn: AmqpConnectionManager;
let publisher: Publisher;
let temp: TempQueue;
let consumer: Consumer | undefined;
const pool = runtimePool('sch', 'medicitas_scheduler');

beforeAll(async () => {
  schedulerConnection = serviceConnection('scheduler-management');
  adminConn = adminConnection('tests:consumer');
  publisher = new Publisher(schedulerConnection, { brokerUser: 'svc_scheduler' });
  await publisher.waitForConnect();
});

afterEach(async () => {
  await consumer?.stop();
  consumer = undefined;
  await temp.cleanup();
});

afterAll(async () => {
  await publisher.close();
  await schedulerConnection.close();
  await adminConn.close();
  await withTransaction(pool, { tenantId: null, actorSubject: null, dbRole: 'sch_worker', isolation: 'READ COMMITTED' }, (client) =>
    client.query("DELETE FROM inbox_messages WHERE consumer LIKE 'test.%'"),
  );
  await pool.end();
});

function event(overrides: Partial<Parameters<typeof createEnvelope>[0]> = {}): Envelope {
  return createEnvelope({
    messageType: 'TestHappened',
    producer: 'scheduler-management',
    tenantId: CLINIC_1,
    actor: { subject: 'system:scheduler-management', roles: ['system'] },
    correlationId: randomUUID(),
    payload: { value: 1 },
    ...overrides,
  });
}

function handler(
  handle: (message: InboundMessage<Payload>) => Promise<void>,
  options: { onExhausted?: (message: InboundMessage<Payload>) => Promise<void> } = {},
): MessageHandler<Payload> {
  return {
    messageType: 'TestHappened',
    payloadSchemas: { 1: Payload },
    allowedProducers: ['scheduler-management'],
    allowedActorRoles: ['system'],
    handle,
    ...(options.onExhausted === undefined ? {} : { onExhausted: (message) => options.onExhausted?.(message) ?? Promise.resolve() }),
  };
}

async function startConsumer(handlers: readonly MessageHandler<Payload>[], tiers = 3): Promise<void> {
  consumer = new Consumer(
    adminConn,
    {
      queue: temp.queue,
      prefetch: 5,
      brokerUser: env('RABBITMQ_ADMIN_USER'),
      retryExchange: temp.retryExchange,
      retryTiersMs: Array.from({ length: tiers }, () => 200),
      handlers,
    },
    silentLogger,
  );
  await consumer.start();
}

async function dlqReasons(): Promise<string[]> {
  const messages = await api.takeMessages(temp.dlq, 10);
  return messages.map((message) => String((message.properties['headers'] as Record<string, unknown>)['x-dead-letter-reason']));
}

describe('consumer reliability (ADR-0003)', () => {
  it('delivers a confirmed message once and ACKs it after the handler resolves', async () => {
    temp = await createTempQueue(api);
    const received: InboundMessage<Payload>[] = [];
    await startConsumer([handler(async (message) => void received.push(message))]);
    const sent = event({ payload: { value: 42 } });
    await publisher.publish(EXCHANGES.events, temp.routingKey, sent);
    await waitFor(() => received.length === 1, 5_000);
    expect(received[0]?.payload).toEqual({ value: 42 });
    expect(received[0]?.envelope.messageId).toBe(sent.messageId);
    expect(received[0]?.deliveryAttempt).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await api.getQueue(temp.queue)).messages ?? 0).toBe(0);
  });

  it('retries transient failures through the delayed tiers, then succeeds', async () => {
    temp = await createTempQueue(api);
    const attempts: number[] = [];
    await startConsumer([
      handler(async (message) => {
        attempts.push(message.deliveryAttempt);
        if (message.deliveryAttempt < 3) throw new TransientMessageError('DB_DOWN', 'simulated outage');
      }),
    ]);
    const started = Date.now();
    await publisher.publish(EXCHANGES.events, temp.routingKey, event());
    await waitFor(() => attempts.length === 3, 10_000);
    expect(attempts).toEqual([1, 2, 3]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400); // two 200 ms tiers, no immediate requeue
    expect(await dlqReasons()).toEqual([]);
  });

  it('dead-letters after the retry budget and calls onExhausted (e.g. to send a failed reply)', async () => {
    temp = await createTempQueue(api);
    const attempts: number[] = [];
    let exhausted = 0;
    await startConsumer([
      handler(
        async (message) => {
          attempts.push(message.deliveryAttempt);
          throw new Error('always failing');
        },
        { onExhausted: async () => void (exhausted += 1) },
      ),
    ]);
    await publisher.publish(EXCHANGES.events, temp.routingKey, event());
    await waitFor(() => exhausted === 1, 10_000);
    expect(attempts).toEqual([1, 2, 3, 4]);
    expect(await dlqReasons()).toEqual(['RETRIES_EXHAUSTED']);
  });

  it('dead-letters permanent failures immediately (no retry)', async () => {
    temp = await createTempQueue(api);
    const attempts: number[] = [];
    await startConsumer([
      handler(async (message) => {
        attempts.push(message.deliveryAttempt);
        throw new PermanentMessageError('UNPROCESSABLE', 'cannot ever succeed');
      }),
    ]);
    await publisher.publish(EXCHANGES.events, temp.routingKey, event());
    await waitFor(() => attempts.length === 1, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(attempts).toEqual([1]);
    expect(await dlqReasons()).toEqual(['UNPROCESSABLE']);
  });

  it('rejects invalid envelopes, spoofed producers, forbidden actors and unknown versions before the handler', async () => {
    temp = await createTempQueue(api);
    let calls = 0;
    await startConsumer([handler(async () => void (calls += 1))]);
    await publisher.publishBuffer(EXCHANGES.events, temp.routingKey, Buffer.from('{"not":"an envelope"}'), {});
    // Published by svc_scheduler but claiming to come from the appointment orchestrator.
    await publisher.publish(EXCHANGES.events, temp.routingKey, event({ producer: 'appointment-orchestrator' }));
    await publisher.publish(
      EXCHANGES.events,
      temp.routingKey,
      event({ actor: { subject: '30000000-0000-4000-8000-000000010002', roles: ['receptionist'] } }),
    );
    await publisher.publish(EXCHANGES.events, temp.routingKey, event({ messageVersion: 2 }));
    await publisher.publish(EXCHANGES.events, temp.routingKey, event({ payload: { value: 'NaN' } }));
    await waitFor(() => false, 1_000).catch(() => undefined);
    expect(calls).toBe(0);
    expect((await dlqReasons()).sort()).toEqual(
      ['ACTOR_NOT_ALLOWED', 'INVALID_ENVELOPE', 'INVALID_PAYLOAD', 'PRODUCER_NOT_ALLOWED', 'UNSUPPORTED_VERSION'].sort(),
    );
  });

  it('applies a duplicated message once (inbox) and returns the stored reply on the duplicate', async () => {
    temp = await createTempQueue(api);
    let effects = 0;
    const storedReplies: (Envelope | null)[] = [];
    await startConsumer([
      handler(async (message) => {
        await withTransaction(
          pool,
          { tenantId: message.envelope.tenantId, actorSubject: null, dbRole: 'sch_system', isolation: 'READ COMMITTED' },
          async (client) => {
            const claim = await claimInbox(client, message.queue, message.envelope);
            if (claim.duplicate) {
              storedReplies.push(claim.storedReply);
              return;
            }
            effects += 1;
            const reply = createReply(message.envelope, {
              messageType: 'TestHappenedReply',
              producer: 'scheduler-management',
              payload: { outcome: 'succeeded', result: { value: message.payload.value }, error: null },
            });
            await storeInboxReply(client, message.queue, message.envelope.messageId, reply);
          },
        );
      }),
    ]);
    const sent = event();
    await publisher.publish(EXCHANGES.events, temp.routingKey, sent);
    await publisher.publish(EXCHANGES.events, temp.routingKey, sent); // redelivery of the same messageId
    await waitFor(() => storedReplies.length === 1, 5_000);
    expect(effects).toBe(1);
    expect(storedReplies[0]?.commandId).toBe(sent.messageId);
  });
});
