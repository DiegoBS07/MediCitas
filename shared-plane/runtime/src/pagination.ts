import { z } from 'zod';
import { ValidationError } from '@medicitas/kernel';

/** Keyset pagination (api-contracts §1.6): limit 1–100 (default 20) and an opaque base64url cursor. */
export const limitSchema = z.coerce.number().int().min(1).max(100).default(20);
export const cursorSchema = z.string().min(1).max(512).optional();

export type CursorValue = string | number;

export function encodeCursor(values: readonly CursorValue[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

/** Decodes a cursor produced by encodeCursor and validates its shape; invalid → 400. */
export function decodeCursor<T>(cursor: string | undefined, schema: z.ZodType<T>): T | null {
  if (cursor === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw invalidCursor();
  return result.data;
}

function invalidCursor(): ValidationError {
  return new ValidationError('The cursor is invalid.', [{ path: 'query.cursor', message: 'invalid cursor' }]);
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly limit: number; readonly nextCursor: string | null };
}

/**
 * Builds a page from rows fetched with LIMIT limit + 1: the extra row only signals that a next
 * page exists; the cursor is built from the last returned row.
 */
export function toPage<Row, Item>(
  rows: readonly Row[],
  limit: number,
  map: (row: Row) => Item,
  cursorOf: (row: Row) => readonly CursorValue[],
): Page<Item> {
  const visible = rows.slice(0, limit);
  const last = visible[visible.length - 1];
  return {
    data: visible.map(map),
    page: { limit, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last)) : null },
  };
}
