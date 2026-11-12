import pg from 'pg';

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly applicationName: string;
  readonly maxConnections?: number;
  readonly connectionTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
}

export type DatabasePool = pg.Pool;
export type DatabaseClient = pg.PoolClient;

/**
 * Creates the runtime pool. The login role (<prefix>_app) has no privileges of its own:
 * every unit of work must go through withTransaction(), which switches to an actor role.
 */
export function createDatabasePool(
  config: DatabaseConfig,
  onIdleClientError: (error: Error) => void = () => undefined,
): DatabasePool {
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    application_name: config.applicationName,
    max: config.maxConnections ?? 10,
    connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
    idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
  });
  // An idle client error must not crash the process; the next checkout reconnects.
  pool.on('error', onIdleClientError);
  return pool;
}
