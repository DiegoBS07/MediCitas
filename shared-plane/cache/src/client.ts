import { createClient } from 'redis';
import type { Logger } from '@medicitas/observability';

export interface CacheClientConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  /** Per-command timeout: a slow cache must not slow availability down (50 ms). */
  readonly commandTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

function buildClient(config: CacheClientConfig) {
  return createClient({
    socket: {
      host: config.host,
      port: config.port,
      connectTimeout: config.connectTimeoutMs ?? 2_000,
      reconnectStrategy: (retries: number) => Math.min(100 * 2 ** retries, 5_000),
    },
    username: config.username,
    password: config.password,
    disableOfflineQueue: true,
    commandOptions: { timeout: config.commandTimeoutMs ?? 50 },
  });
}

export type RedisConnection = ReturnType<typeof buildClient>;

/**
 * Redis client tuned for a cache that must FAIL FAST: no offline queue (commands are rejected
 * immediately while disconnected, so callers bypass to PostgreSQL), short command timeout,
 * and background reconnection with capped back-off.
 */
export function createCacheConnection(config: CacheClientConfig, logger: Logger): RedisConnection {
  const client = buildClient(config);
  let lastWarning = 0;
  client.on('error', (error: Error) => {
    // Throttled: a down cache must not flood the logs.
    if (Date.now() - lastWarning > 10_000) {
      lastWarning = Date.now();
      logger.warn({ err: error.message }, 'redis unavailable; cache reads bypass to PostgreSQL');
    }
  });
  client.on('ready', () => logger.info('redis connected'));
  return client;
}
