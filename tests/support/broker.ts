import { randomUUID } from 'node:crypto';
import {
  EXCHANGES,
  ManagementApi,
  createBrokerConnection,
  queueDeclarationsFor,
  serviceDefinition,
  type AmqpConnectionManager,
  type ServiceName,
} from '@medicitas/messaging';
import { createLogger } from '@medicitas/observability';
import { HOST, env } from './env.js';

export const silentLogger = createLogger({ service: 'tests', level: 'silent' });

export function managementApi(): ManagementApi {
  return new ManagementApi({
    baseUrl: `http://${HOST}:${process.env['RABBITMQ_MANAGEMENT_HOST_PORT'] ?? 15672}`,
    adminUser: env('RABBITMQ_ADMIN_USER'),
    adminPassword: env('RABBITMQ_ADMIN_PASSWORD'),
    vhost: env('RABBITMQ_VHOST'),
  });
}

export function adminConnection(name: string): AmqpConnectionManager {
  return createBrokerConnection(
    {
      host: HOST,
      port: Number(process.env['RABBITMQ_AMQP_HOST_PORT'] ?? 5672),
      vhost: env('RABBITMQ_VHOST'),
      username: env('RABBITMQ_ADMIN_USER'),
      password: env('RABBITMQ_ADMIN_PASSWORD'),
      connectionName: name,
    },
    silentLogger,
  );
}

/** Connection with the real least-privilege identity of a service. */
export function serviceConnection(service: ServiceName): AmqpConnectionManager {
  const definition = serviceDefinition(service);
  return createBrokerConnection(
    {
      host: HOST,
      port: Number(process.env['RABBITMQ_AMQP_HOST_PORT'] ?? 5672),
      vhost: env('RABBITMQ_VHOST'),
      username: definition.brokerUser,
      password: env(definition.passwordEnv),
      connectionName: `tests:${service}`,
    },
    silentLogger,
  );
}

export function amqpUrl(user: string, password: string): string {
  const port = process.env['RABBITMQ_AMQP_HOST_PORT'] ?? '5672';
  return `amqp://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${HOST}:${port}/${encodeURIComponent(env('RABBITMQ_VHOST'))}`;
}

export interface TempQueue {
  readonly queue: string;
  readonly retryExchange: string;
  readonly routingKey: string;
  readonly dlq: string;
  cleanup(): Promise<void>;
}

/**
 * Isolated test queue (same shape as production: quorum main queue, retry tiers, DLQ) bound to a
 * unique routing key, so tests never compete with running services for real queues.
 */
export async function createTempQueue(
  api: ManagementApi,
  options: { readonly exchange?: string; readonly retryTiersMs?: readonly number[] } = {},
): Promise<TempQueue> {
  const id = randomUUID().slice(0, 8);
  const queue = `test.${id}`;
  const retryExchange = `test.retry.${id}`;
  const routingKey = `test.${id}.message`;
  await api.ensureExchange({ name: retryExchange, type: 'direct' });
  const declarations = queueDeclarationsFor(
    {
      name: queue,
      bindings: [{ exchange: options.exchange ?? EXCHANGES.events, routingKey: `test.${id}.#` }],
      prefetch: 5,
      retryTiersMs: options.retryTiersMs ?? [200, 200, 200],
    },
    retryExchange,
  );
  for (const declaration of declarations) await api.ensureQueue(declaration);
  return {
    queue,
    retryExchange,
    routingKey,
    dlq: `${queue}.dlq`,
    async cleanup() {
      for (const declaration of declarations) await api.deleteQueue(declaration.name);
      await api.deleteExchange(retryExchange);
    },
  };
}
