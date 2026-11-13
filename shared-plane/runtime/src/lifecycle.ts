import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express, Router } from 'express';
import { createHttpApp } from './http.js';
import { createDatabasePool, type DatabasePool } from '@medicitas/kernel';
import { createJwtVerifier, type JwtVerifier } from '@medicitas/identity';
import {
  Consumer,
  OutboxRelay,
  Publisher,
  consumerConfigFor,
  createBrokerConnection,
  serviceDefinition,
  type AmqpConnectionManager,
  type MessageHandler,
  type ServiceName,
} from '@medicitas/messaging';
import { createLogger, type HealthCheck, type Logger } from '@medicitas/observability';
import type { ServiceConfig } from './config.js';

/** Ordered shutdown hooks (last registered closes first). */
export class Lifecycle {
  private readonly closers: { readonly name: string; readonly close: () => Promise<void> }[] = [];
  private closing: Promise<void> | undefined;

  constructor(private readonly logger: Logger) {}

  onShutdown(name: string, close: () => Promise<void>): void {
    this.closers.push({ name, close });
  }

  shutdown(): Promise<void> {
    this.closing ??= (async () => {
      for (const closer of [...this.closers].reverse()) {
        try {
          await closer.close();
        } catch (error) {
          this.logger.warn({ component: closer.name, err: (error as Error).message }, 'shutdown step failed');
        }
      }
    })();
    return this.closing;
  }

  /** SIGTERM/SIGINT → graceful shutdown (stop consuming, finish in-flight work, close resources). */
  installSignalHandlers(): void {
    const handle = (signal: string): void => {
      this.logger.info({ signal }, 'shutting down');
      void this.shutdown().then(() => process.exit(0));
    };
    process.once('SIGTERM', handle);
    process.once('SIGINT', handle);
  }
}

export function listen(app: Express, port: number, host = '0.0.0.0'): Promise<{ readonly server: Server; readonly port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, (error?: Error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

/** Infrastructure shared by every service: logger, DB pool, broker connection, publisher, outbox relay, JWT verifier. */
export interface ServiceInfrastructure {
  readonly service: ServiceName;
  readonly logger: Logger;
  readonly pool: DatabasePool;
  readonly connection: AmqpConnectionManager;
  readonly publisher: Publisher;
  readonly relay: OutboxRelay;
  readonly verifier: JwtVerifier;
  readonly lifecycle: Lifecycle;
  readonly health: readonly HealthCheck[];
  /** Starts one manual-ack consumer per queue (handlers resolved by messageType). */
  startConsumers(queues: Readonly<Record<string, readonly MessageHandler<unknown>[]>>): Promise<void>;
}

export interface InfrastructureOptions {
  /** <prefix>_worker role used by the outbox relay. */
  readonly workerDbRole: string;
  readonly logger?: Logger;
}

export async function createServiceInfrastructure(
  service: ServiceName,
  config: ServiceConfig,
  options: InfrastructureOptions,
): Promise<ServiceInfrastructure> {
  const logger = options.logger ?? createLogger({ service, level: config.logLevel });
  const lifecycle = new Lifecycle(logger);
  const definition = serviceDefinition(service);

  const pool = createDatabasePool(config.database, (error) => logger.warn({ err: error.message }, 'idle database client error'));
  lifecycle.onShutdown('database', () => pool.end());

  const connection = createBrokerConnection(
    {
      host: config.broker.host,
      port: config.broker.port,
      vhost: config.broker.vhost,
      username: definition.brokerUser,
      password: config.broker.password,
      connectionName: service,
    },
    logger,
  );
  lifecycle.onShutdown('broker', () => connection.close());

  const publisher = new Publisher(connection, { brokerUser: definition.brokerUser });
  lifecycle.onShutdown('publisher', () => publisher.close());

  const relay = new OutboxRelay(pool, publisher, { workerRole: options.workerDbRole }, logger);
  lifecycle.onShutdown('outbox relay', () => relay.stop());

  const verifier = createJwtVerifier(config.identity);

  const health: HealthCheck[] = [
    { name: 'database', check: async () => void (await pool.query('SELECT 1')) },
    {
      name: 'broker',
      check: async () => {
        if (!connection.isConnected()) throw new Error('broker disconnected');
      },
    },
  ];

  await relay.start();

  return {
    service,
    logger,
    pool,
    connection,
    publisher,
    relay,
    verifier,
    lifecycle,
    health,
    async startConsumers(queues) {
      for (const [queue, handlers] of Object.entries(queues)) {
        const consumer = new Consumer(connection, consumerConfigFor(service, queue, handlers), logger);
        await consumer.start();
        lifecycle.onShutdown(`consumer ${queue}`, () => consumer.stop());
      }
    },
  };
}

export interface RunningService {
  readonly port: number;
  readonly logger: Logger;
  stop(): Promise<void>;
}

/** Mounts the HTTP app of a service and registers its graceful close (closed first on shutdown). */
export async function serveHttp(
  infrastructure: ServiceInfrastructure,
  routes: (router: Router) => void,
  port: number,
): Promise<RunningService> {
  const app = createHttpApp({ logger: infrastructure.logger, health: infrastructure.health, verifier: infrastructure.verifier, routes });
  const { server, port: boundPort } = await listen(app, port);
  infrastructure.lifecycle.onShutdown('http', () => closeServer(server));
  infrastructure.logger.info({ port: boundPort }, `${infrastructure.service} started`);
  return { port: boundPort, logger: infrastructure.logger, stop: () => infrastructure.lifecycle.shutdown() };
}
