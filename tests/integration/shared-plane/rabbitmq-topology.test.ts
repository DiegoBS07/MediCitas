import amqplib from 'amqplib';
import { describe, expect, it } from 'vitest';
import {
  EXCHANGES,
  SERVICES,
  applyTopology,
  queueDeclarationsFor,
  retryExchangeOf,
  serviceDefinition,
} from '@medicitas/messaging';
import { amqpUrl, managementApi } from '../../support/broker.js';
import { env } from '../../support/env.js';

const api = managementApi();
const passwords = Object.fromEntries(SERVICES.map((service) => [service.passwordEnv, env(service.passwordEnv)]));

/** Opens a raw channel as a service user and returns the first channel/connection error (or null). */
async function brokerErrorOf(service: Parameters<typeof serviceDefinition>[0], action: (channel: amqplib.ConfirmChannel) => Promise<unknown>): Promise<string | null> {
  const definition = serviceDefinition(service);
  const connection = await amqplib.connect(amqpUrl(definition.brokerUser, env(definition.passwordEnv)));
  connection.on('error', () => undefined);
  const channel = await connection.createConfirmChannel();
  const closed = new Promise<string>((resolve) => {
    channel.on('error', (error: Error) => resolve(error.message));
  });
  channel.on('close', () => undefined);
  try {
    const outcome = await Promise.race([
      action(channel).then(() => new Promise<null>((resolve) => setTimeout(() => resolve(null), 500))),
      closed,
    ]);
    return outcome;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    await connection.close().catch(() => undefined);
  }
}

describe('RabbitMQ topology bootstrap (ADR-0003)', () => {
  it('is idempotent: re-applying produces the same topology without errors', async () => {
    const first = await applyTopology(api, passwords);
    const second = await applyTopology(api, passwords);
    expect(second).toEqual(first);
    expect(first).toEqual({ exchanges: 12, queues: 65, bindings: 68, users: 7 });
  });

  it('declares every consumer queue, retry tier and DLQ as a quorum queue with the contract arguments', async () => {
    for (const service of SERVICES) {
      for (const queue of service.consumes) {
        for (const declaration of queueDeclarationsFor(queue, retryExchangeOf(service.service))) {
          const actual = await api.getQueue(declaration.name);
          expect(actual.type, declaration.name).toBe('quorum');
          for (const [key, value] of Object.entries(declaration.arguments)) {
            expect(actual.arguments?.[key], `${declaration.name} ${key}`).toBe(value);
          }
        }
      }
    }
  });
});

describe('RabbitMQ least privilege per service', () => {
  it('a service cannot publish to an exchange it does not own (scheduler → commands)', async () => {
    const error = await brokerErrorOf('scheduler-management', async (channel) => {
      channel.publish(EXCHANGES.commands, 'appointment-orchestrator.x', Buffer.from('{}'), { userId: 'svc_scheduler' });
      await channel.waitForConfirms();
    });
    expect(error).toMatch(/ACCESS_REFUSED|403/);
  });

  it('a service cannot publish into another service retry exchange', async () => {
    const error = await brokerErrorOf('scheduler-management', async (channel) => {
      channel.publish(retryExchangeOf('appointment-orchestrator'), 'appointment-orchestrator.replies.retry.1', Buffer.from('{}'), {
        userId: 'svc_scheduler',
      });
      await channel.waitForConfirms();
    });
    expect(error).toMatch(/ACCESS_REFUSED|403/);
  });

  it('a service cannot consume another service queue', async () => {
    const error = await brokerErrorOf('scheduler-management', (channel) =>
      channel.consume('user-management.commands', () => undefined),
    );
    expect(error).toMatch(/ACCESS_REFUSED|403/);
  });

  it('a service cannot declare queues (no configure permission)', async () => {
    const error = await brokerErrorOf('scheduler-management', (channel) =>
      channel.assertQueue('scheduler-management.rogue', { durable: true }),
    );
    expect(error).toMatch(/ACCESS_REFUSED|403/);
  });

  it('the broker rejects a spoofed user_id property (producer identity cannot be forged)', async () => {
    const error = await brokerErrorOf('scheduler-management', async (channel) => {
      channel.publish(EXCHANGES.events, 'scheduler.test.spoof', Buffer.from('{}'), { userId: 'svc_appointment_orchestrator' });
      await channel.waitForConfirms();
    });
    expect(error).toMatch(/PRECONDITION_FAILED|406|user_id/i);
  });
});
