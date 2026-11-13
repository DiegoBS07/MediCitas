import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { BusinessRuleError, ConflictError, ValidationError, type DatabaseClient } from '@medicitas/kernel';

/** Idempotency-Key format (api-contracts §1.2). */
const KEY_FORMAT = /^[A-Za-z0-9_-]{16,64}$/;

/** Reads the Idempotency-Key header; missing or malformed on a `required` route → 400 IDEMPOTENCY_KEY_REQUIRED. */
export function idempotencyKeyOf(request: Request, required: boolean): string | null {
  const raw = request.get('Idempotency-Key');
  if (raw === undefined || raw === '') {
    if (required) throw keyRequired('The Idempotency-Key header is required on this route.');
    return null;
  }
  if (!KEY_FORMAT.test(raw)) throw keyRequired('The Idempotency-Key header must match [A-Za-z0-9_-]{16,64}.');
  return raw;
}

function keyRequired(message: string): ValidationError {
  return new ValidationError(message, [{ path: 'header.Idempotency-Key', message }], 'IDEMPOTENCY_KEY_REQUIRED');
}

/** Canonical JSON (object keys sorted recursively), so semantically equal bodies hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function requestHash(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body ?? null)).digest('hex');
}

export interface IdempotencyScope {
  readonly tenantId: string | null;
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly routeTemplate: string;
  readonly key: string;
  readonly requestHash: string;
}

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

export type IdempotencyStart =
  | { readonly kind: 'new'; readonly recordId: string }
  | { readonly kind: 'replay'; readonly response: StoredResponse }
  | { readonly kind: 'in_progress'; readonly operationId: string | null };

interface RecordRow {
  readonly id: string;
  readonly request_hash: string;
  readonly status: 'in_progress' | 'completed';
  readonly operation_id: string | null;
  readonly response_status: number | null;
  readonly response_body: unknown;
}

/**
 * Claims an idempotency record inside the caller's transaction (table idempotency_records, RLS by
 * tenant). A concurrent request with the same key blocks on the unique index until the first one
 * commits or rolls back, so for local (single-transaction) operations the outcome is always
 * either "new" or "replay"; "in_progress" is only visible for saga routes.
 * Same key + different body → 422 IDEMPOTENCY_KEY_REUSED.
 */
export async function beginIdempotent(client: DatabaseClient, scope: IdempotencyScope): Promise<IdempotencyStart> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO idempotency_records (tenant_id, http_method, route_template, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT ON CONSTRAINT idempotency_records_scope_unique DO NOTHING
     RETURNING id`,
    [scope.tenantId, scope.method, scope.routeTemplate, scope.key, scope.requestHash],
  );
  const created = inserted.rows[0];
  if (created !== undefined) return { kind: 'new', recordId: created.id };

  const existing = await client.query<RecordRow>(
    `SELECT id, request_hash, status, operation_id, response_status, response_body
     FROM idempotency_records
     WHERE tenant_id IS NOT DISTINCT FROM $1 AND http_method = $2 AND route_template = $3 AND idempotency_key = $4`,
    [scope.tenantId, scope.method, scope.routeTemplate, scope.key],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    // Expired and deleted between the two statements: treat as a concurrent conflict.
    throw new ConflictError('OPERATION_IN_PROGRESS', 'A request with this Idempotency-Key is being processed.');
  }
  if (row.request_hash !== scope.requestHash) {
    throw new BusinessRuleError('IDEMPOTENCY_KEY_REUSED', 'The Idempotency-Key was already used with a different request body.');
  }
  if (row.status === 'completed' && row.response_status !== null) {
    return { kind: 'replay', response: { status: row.response_status, body: row.response_body } };
  }
  return { kind: 'in_progress', operationId: row.operation_id };
}

export async function completeIdempotent(client: DatabaseClient, recordId: string, response: StoredResponse): Promise<void> {
  await client.query(
    `UPDATE idempotency_records SET status = 'completed', response_status = $2, response_body = $3 WHERE id = $1`,
    [recordId, response.status, JSON.stringify(response.body)],
  );
}

export async function attachOperation(client: DatabaseClient, recordId: string, operationId: string): Promise<void> {
  await client.query('UPDATE idempotency_records SET operation_id = $2 WHERE id = $1', [recordId, operationId]);
}

export interface IdempotentOutcome {
  readonly response: StoredResponse;
  readonly replayed: boolean;
}

/**
 * Local mutation with optional idempotency, all in ONE transaction: claim → work → store response.
 * Errors roll everything back (including the claim), so a failed request can simply be retried.
 */
export async function runIdempotent(
  client: DatabaseClient,
  scope: Omit<IdempotencyScope, 'key'> & { readonly key: string | null },
  work: () => Promise<StoredResponse>,
): Promise<IdempotentOutcome> {
  if (scope.key === null) return { response: await work(), replayed: false };
  const start = await beginIdempotent(client, { ...scope, key: scope.key });
  if (start.kind === 'replay') return { response: start.response, replayed: true };
  if (start.kind === 'in_progress') {
    throw new ConflictError('OPERATION_IN_PROGRESS', 'A request with this Idempotency-Key is being processed.');
  }
  const response = await work();
  await completeIdempotent(client, start.recordId, response);
  return { response, replayed: false };
}
