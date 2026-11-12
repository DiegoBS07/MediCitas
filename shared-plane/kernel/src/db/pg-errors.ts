/** Structured view of a node-postgres error (SQLSTATE and constraint name). */
export interface PgErrorInfo {
  readonly sqlState: string | null;
  readonly constraint: string | null;
  readonly message: string;
}

interface PgLikeError {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly message?: unknown;
}

export function pgErrorInfo(error: unknown): PgErrorInfo {
  if (typeof error !== 'object' || error === null) {
    return { sqlState: null, constraint: null, message: String(error) };
  }
  const candidate = error as PgLikeError;
  return {
    sqlState: typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code) ? candidate.code : null,
    constraint: typeof candidate.constraint === 'string' ? candidate.constraint : null,
    message: typeof candidate.message === 'string' ? candidate.message : 'unknown database error',
  };
}

/** SQLSTATEs that mean "the same transaction may succeed if replayed" (ADR-0007). */
export const RETRYABLE_TRANSACTION_STATES: ReadonlySet<string> = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
]);

/** Connection-level failures: the database is (temporarily) unreachable. */
const CONNECTION_STATE_PREFIXES = ['08', '53', '57P0'];
const CONNECTION_ERROR_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND']);

export function isRetryableTransactionError(error: unknown): boolean {
  const { sqlState } = pgErrorInfo(error);
  return sqlState !== null && RETRYABLE_TRANSACTION_STATES.has(sqlState);
}

export function isConnectionError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (CONNECTION_ERROR_CODES.has(code)) return true;
      if (/^[0-9A-Z]{5}$/.test(code) && CONNECTION_STATE_PREFIXES.some((prefix) => code.startsWith(prefix))) {
        return true;
      }
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && /Connection terminated|timeout exceeded when trying to connect/i.test(message)) {
      return true;
    }
  }
  return false;
}

/** True when the error is an exclusion (23P01), unique (23505), check (23514) or FK (23503) violation. */
export function isConstraintViolation(error: unknown): boolean {
  const { sqlState } = pgErrorInfo(error);
  return sqlState === '23P01' || sqlState === '23505' || sqlState === '23514' || sqlState === '23503';
}
