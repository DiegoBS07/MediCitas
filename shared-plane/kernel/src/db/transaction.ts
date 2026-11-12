import { setTimeout as sleep } from 'node:timers/promises';
import { ConcurrencyConflictError, DependencyUnavailableError } from '../errors.js';
import { isUuid } from '../ids.js';
import { isConnectionError, isRetryableTransactionError } from './pg-errors.js';
import type { DatabaseClient, DatabasePool } from './pool.js';

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * Security and isolation context of one database transaction (ADR-0004, ADR-0007, ADR-0009).
 * - tenantId     → app.tenant_id   (RLS; null only for control-plane/platform work)
 * - actorSubject → app.actor_subject ("own" rules, audit)
 * - dbRole       → the actor role the runtime login switches to for this transaction only
 */
export interface TransactionContext {
  readonly tenantId: string | null;
  readonly actorSubject: string | null;
  readonly dbRole: string;
  readonly isolation: IsolationLevel;
  readonly readOnly?: boolean;
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
}

export interface TransactionOptions {
  /** Replays on 40001/40P01/55P03. The work function must be safe to replay (it is: it runs in a fresh transaction). */
  readonly maxRetries?: number;
}

const ROLE_NAME = /^[a-z][a-z0-9_]{1,62}$/;
const DEFAULT_MAX_RETRIES = 3;

/**
 * Runs `work` inside one transaction with explicit isolation, tenant context and actor role.
 * Everything is set with bind parameters (set_config(..., true) is transaction-local), so a
 * pooled connection never carries a tenant or a role into the next transaction.
 */
export async function withTransaction<T>(
  pool: DatabasePool,
  context: TransactionContext,
  work: (client: DatabaseClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  assertContext(context);
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  for (let attempt = 0; ; attempt += 1) {
    let client: DatabaseClient;
    try {
      client = await pool.connect();
    } catch (error) {
      throw new DependencyUnavailableError('database', error);
    }

    let broken = false;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${context.isolation}${context.readOnly === true ? ' READ ONLY' : ''}`);
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true),
                set_config('app.actor_subject', $2, true),
                set_config('lock_timeout', $3, true),
                set_config('statement_timeout', $4, true),
                set_config('role', $5, true)`,
        [
          context.tenantId ?? '',
          context.actorSubject ?? '',
          `${context.lockTimeoutMs ?? 2_000}ms`,
          `${context.statementTimeoutMs ?? 5_000}ms`,
          context.dbRole,
        ],
      );
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      broken = isConnectionError(error);
      if (!broken) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true;
        }
      }
      if (isRetryableTransactionError(error)) {
        if (attempt < maxRetries) {
          await sleep(20 + Math.floor(Math.random() * 80));
          continue;
        }
        throw new ConcurrencyConflictError(error);
      }
      if (broken) {
        throw new DependencyUnavailableError('database', error);
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }
}

function assertContext(context: TransactionContext): void {
  if (!ROLE_NAME.test(context.dbRole)) {
    throw new Error(`Invalid database role name: ${context.dbRole}`);
  }
  if (context.tenantId !== null && !isUuid(context.tenantId)) {
    throw new Error('tenantId must be a canonical UUID or null');
  }
  if (context.actorSubject !== null && !isUuid(context.actorSubject)) {
    throw new Error('actorSubject must be a canonical UUID or null');
  }
}
