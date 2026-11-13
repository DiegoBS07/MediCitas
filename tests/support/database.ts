import { createDatabasePool, type DatabasePool } from '@medicitas/kernel';
import { HOST, env } from './env.js';

/** Runtime pool exactly like a service: login <prefix>_app, which can only SET ROLE to actor roles. */
export function runtimePool(prefix: 'tm' | 'onb' | 'um' | 'umo' | 'cat' | 'sch' | 'ao', database: string): DatabasePool {
  return createDatabasePool({
    host: HOST,
    port: Number(process.env['POSTGRES_HOST_PORT'] ?? 5432),
    database,
    user: `${prefix}_app`,
    password: env(`${prefix.toUpperCase()}_DB_APP_PASSWORD`),
    applicationName: 'medicitas-tests',
    maxConnections: 5,
  });
}

/** Evidence login (<prefix>_readonly): SELECT on non-sensitive tables, RLS applies. */
export function readonlyPool(prefix: string, database: string): DatabasePool {
  return createDatabasePool({
    host: HOST,
    port: Number(process.env['POSTGRES_HOST_PORT'] ?? 5432),
    database,
    user: `${prefix}_readonly`,
    password: env('DB_EVIDENCE_PASSWORD'),
    applicationName: 'medicitas-tests',
    maxConnections: 2,
  });
}

export const CLINIC_1 = '10000000-0000-4000-8000-000000000001';
export const CLINIC_2 = '10000000-0000-4000-8000-000000000002';

/**
 * Owner login (<prefix>_owner), used ONLY to clean up rows created by integration tests in tables
 * where runtime roles have no DELETE grant by design (e.g. control-plane tenants).
 */
export function ownerPool(prefix: 'tm' | 'onb' | 'um' | 'umo' | 'cat' | 'sch' | 'ao', database: string): DatabasePool {
  return createDatabasePool({
    host: HOST,
    port: Number(process.env['POSTGRES_HOST_PORT'] ?? 5432),
    database,
    user: `${prefix}_owner`,
    password: env(`${prefix.toUpperCase()}_DB_OWNER_PASSWORD`),
    applicationName: 'medicitas-tests-cleanup',
    maxConnections: 1,
  });
}
