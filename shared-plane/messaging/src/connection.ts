import amqp, { type AmqpConnectionManager } from 'amqp-connection-manager';
import type { Logger } from '@medicitas/observability';

export type { AmqpConnectionManager } from 'amqp-connection-manager';

export interface BrokerConnectionConfig {
  readonly host: string;
  readonly port: number;
  readonly vhost: string;
  readonly username: string;
  readonly password: string;
  /** Shown in the management UI (connection name). */
  readonly connectionName: string;
  readonly heartbeatSeconds?: number;
}

/**
 * Connection with automatic recovery: on failure amqp-connection-manager reconnects, re-creates
 * channels, re-runs setup functions and re-subscribes consumers. Unconfirmed publishes are
 * retried; the outbox makes that safe (consumers de-duplicate through the inbox).
 */
export function createBrokerConnection(config: BrokerConnectionConfig, logger: Logger): AmqpConnectionManager {
  const connection = amqp.connect(
    [
      {
        protocol: 'amqp',
        hostname: config.host,
        port: config.port,
        vhost: config.vhost,
        username: config.username,
        password: config.password,
        heartbeat: config.heartbeatSeconds ?? 15,
      },
    ],
    {
      reconnectTimeInSeconds: 2,
      connectionOptions: { clientProperties: { connection_name: config.connectionName } },
    },
  );
  connection.on('connect', () => logger.info({ broker: config.host }, 'broker connected'));
  connection.on('disconnect', ({ err }) => logger.warn({ err: err?.message }, 'broker disconnected; reconnecting'));
  connection.on('connectFailed', ({ err }) => logger.warn({ err: err?.message }, 'broker connection failed; retrying'));
  connection.on('blocked', ({ reason }) => logger.warn({ reason }, 'broker blocked the connection (resource alarm)'));
  return connection;
}
