import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DependencyUnavailableError, withTransaction } from '@medicitas/kernel';
import {
  Consumer,
  EXCHANGES,
  OutboxRelay,
  Publisher,
  QueryClient,
  createBrokerConnection,
  createEnvelope,
  enqueueOutbox,
  respondToQuery,
  type AmqpConnectionManager,
  type Envelope,
} from '@medicitas/messaging';
import { CLINIC_1, runtimePool } from '../../support/database.js';
import { adminConnection, createTempQueue, managementApi, serviceConnection, silentLogger } from '../../support/broker.js';
import { HOST, env, waitFor } from '../../support/env.js';

const api = managementApi();
const pool = runtimePool('sch', 'medicitas_scheduler');
let schedulerConnection: AmqpConnectionManager;
let catalogConnection: AmqpConnectionManager;
let adminConn: AmqpConnectionManager;
let publisher: Publisher;

const worker = { tenantId: null, actorSubject: null, dbRole: 'sch_worker', isolation: 'READ COMMITTED' as const };

beforeAll(async () => {
  schedulerConnection = serviceConnection('scheduler-management');
  catalogConnection = serviceConnection('catalog-service-management');
  adminConn = adminConnection('tests:outbox');
  publisher = new Publisher(schedulerConnection, { brokerUser: 'svc_scheduler' });
  await publisher.waitForConnect();
});

afterAll(async () => {
  await withTransaction(pool, worker, (client) => client.query("DELETE FROM outbox_messages WHERE routing_key LIKE 'test.%'"));
  await publisher.close();
  await schedulerConnection.close();
  await catalogConnection.close();
  await adminConn.close();
  await pool.end();
});

function domainEvent(routingKeyOwner: string): Envelope {
  return createEnvelope({
    messageType: 'AvailabilityChanged',
    producer: 'scheduler-management',
    tenantId: CLINIC_1,
    actor: { subject: '30000000-0000-4000-8000-000000010002', roles: ['receptionist'] },
    correlationId: randomUUID(),
    payload: { probe: routingKeyOwner },
  });
}

async function enqueue(envelope: Envelope, routingKey: string): Promise<void> {
  await withTransaction(
    pool,
    { tenantId: CLINIC_1, actorSubject: null, dbRole: 'sch_system', isolation: 'READ COMMITTED' },
    (client) => enqueueOutbox(client, { exchange: EXCHANGES.events, routingKey, envelope }),
  );
}

async function outboxRow(id: string): Promise<{ published_at: Date | null; attempts: number; last_error: string | null }> {
  return withTransaction(pool, worker, async (client) => {
    const { rows } = await client.query<{ published_at: Date | null; attempts: number; last_error: string | null }>(
      'SELECT published_at, attempts, last_error FROM outbox_messages WHERE id = $1',
      [id],
    );
    if (rows[0] === undefined) throw new Error('outbox row not found');
    return rows[0];
  });
}

describe('transactional outbox relay (ADR-0003)', () => {
  it('publishes committed rows after the publisher confirm and marks them published', async () => {
    const temp = await createTempQueue(api);
    const received: string[] = [];
    const consumer = new Consumer(
      adminConn,
      {
        queue: temp.queue,
        prefetch: 5,
        brokerUser: env('RABBITMQ_ADMIN_USER'),
        retryExchange: temp.retryExchange,
        handlers: [
          {
            messageType: 'AvailabilityChanged',
            payloadSchemas: { 1: z.object({ probe: z.string() }) },
            allowedProducers: ['scheduler-management'],
            allowedActorRoles: ['receptionist'],
            handle: async (message) => void received.push(message.envelope.messageId),
          },
        ],
      },
      silentLogger,
    );
    await consumer.start();
    const relay = new OutboxRelay(pool, publisher, { workerRole: 'sch_worker', pollIntervalMs: 200 }, silentLogger);
    try {
      const envelope = domainEvent(temp.queue);
      await enqueue(envelope, temp.routingKey);
      await relay.start(); // LISTEN/NOTIFY + polling
      await waitFor(() => received.includes(envelope.messageId), 10_000);
      const row = await outboxRow(envelope.messageId);
      expect(row.published_at).not.toBeNull();
      expect(row.attempts).toBe(1);
    } finally {
      await relay.stop();
      await consumer.stop();
      await temp.cleanup();
    }
  });

  it('keeps the row pending and reschedules it with back-off when the broker is unreachable', async () => {
    const unreachable = createBrokerConnection(
      { host: HOST, port: 5999, vhost: 'medicitas', username: 'x', password: 'x', connectionName: 'tests:down' },
      silentLogger,
    );
    const failingPublisher = new Publisher(unreachable, { brokerUser: 'svc_scheduler', publishTimeoutMs: 300 });
    const relay = new OutboxRelay(pool, failingPublisher, { workerRole: 'sch_worker' }, silentLogger);
    const envelope = domainEvent('down');
    await enqueue(envelope, `test.${randomUUID().slice(0, 8)}.down`);
    try {
      await relay.drain();
      const row = await outboxRow(envelope.messageId);
      expect(row.published_at).toBeNull();
      expect(row.attempts).toBe(1);
      expect(row.last_error).not.toBeNull();
    } finally {
      await unreachable.close();
    }
    // Once the broker is reachable the same row is published (after its back-off).
    const healthyRelay = new OutboxRelay(pool, publisher, { workerRole: 'sch_worker' }, silentLogger);
    await new Promise((resolve) => setTimeout(resolve, 600));
    await healthyRelay.drain();
    expect((await outboxRow(envelope.messageId)).published_at).not.toBeNull();
  });
});

describe('synchronous query over direct reply-to (ADR-0003)', () => {
  it('returns the responder result to the exact requester and times out as 503 when nobody answers', async () => {
    const temp = await createTempQueue(api, { exchange: EXCHANGES.queries });
    const responderPublisher = new Publisher(adminConn, { brokerUser: env('RABBITMQ_ADMIN_USER') });
    const responder = new Consumer(
      adminConn,
      {
        queue: temp.queue,
        prefetch: 5,
        brokerUser: env('RABBITMQ_ADMIN_USER'),
        retryExchange: temp.retryExchange,
        handlers: [
          {
            messageType: 'GetTenantUserQuery',
            payloadSchemas: { 1: z.object({ userId: z.uuid() }).strict() },
            allowedProducers: ['catalog-service-management'],
            allowedActorRoles: ['clinic_admin'],
            handle: async (message) => {
              const reply = createEnvelope({
                messageType: 'TenantUserQueryResult',
                producer: 'user-management',
                tenantId: message.envelope.tenantId,
                actor: message.envelope.actor,
                correlationId: message.envelope.correlationId,
                causationId: message.envelope.messageId,
                payload: { found: true, user: { userId: (message.payload as { userId: string }).userId, role: 'health_professional' } },
              });
              await respondToQuery(responderPublisher, message, reply);
            },
          },
        ],
      },
      silentLogger,
    );
    await responder.start();
    const client = new QueryClient(catalogConnection, { brokerUser: 'svc_catalog', timeoutMs: 1_500 });
    try {
      const userId = '20000000-0000-4000-8000-000000010011';
      const query = createEnvelope({
        messageType: 'GetTenantUserQuery',
        producer: 'catalog-service-management',
        tenantId: CLINIC_1,
        actor: { subject: '30000000-0000-4000-8000-000000010001', roles: ['clinic_admin'] },
        correlationId: randomUUID(),
        payload: { userId },
      });
      const result = await client.request(
        temp.routingKey,
        query,
        z.object({ found: z.boolean(), user: z.object({ userId: z.string(), role: z.string() }) }),
      );
      expect(result).toEqual({ found: true, user: { userId, role: 'health_professional' } });

      const unanswered = createEnvelope({ ...query, messageId: randomUUID() });
      await expect(
        client.request(`test.${randomUUID().slice(0, 8)}.nobody`, unanswered, z.object({})),
      ).rejects.toBeInstanceOf(DependencyUnavailableError);
    } finally {
      await client.close();
      await responder.stop();
      await responderPublisher.close();
      await temp.cleanup();
    }
  });
});
