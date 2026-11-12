import { randomUUID } from 'node:crypto';

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True for a canonical lowercase RFC 9562 UUID (versions 1–8). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID.test(value);
}

export function newId(): string {
  return randomUUID();
}
