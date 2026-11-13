import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConflictError, NotFoundError, ValidationError } from '@medicitas/kernel';
import { canonicalJson, decodeCursor, encodeCursor, parseInput, requestHash, toPage, toProblem } from '../src/index.js';

const correlationId = '4b8a6f0e-2f8e-4b8e-9a51-0f8d0f3c2a11';

describe('problem+json mapping (api-contracts §1.4)', () => {
  it('maps application errors to their status and stable code', () => {
    const notFound = toProblem(new NotFoundError('patient'), correlationId);
    expect(notFound.status).toBe(404);
    expect(notFound.body).toMatchObject({
      type: 'urn:medicitas:problem:resource-not-found',
      code: 'RESOURCE_NOT_FOUND',
      correlationId,
      details: { resource: 'patient' },
    });
    expect(toProblem(new ConflictError('SLOT_TAKEN', 'taken'), correlationId).status).toBe(409);
    const invalid = toProblem(new ValidationError('bad', [{ path: 'body.startAt', message: 'required' }]), correlationId);
    expect(invalid.body.errors).toEqual([{ path: 'body.startAt', message: 'required' }]);
  });

  it('never leaks internals of unexpected errors', () => {
    const result = toProblem(new Error('relation "secret_table" does not exist'), correlationId);
    expect(result.status).toBe(500);
    expect(JSON.stringify(result.body)).not.toContain('secret_table');
  });

  it('maps body-parser failures to 413/400', () => {
    expect(toProblem({ type: 'entity.too.large' }, correlationId).status).toBe(413);
    expect(toProblem({ type: 'entity.parse.failed' }, correlationId).body.code).toBe('VALIDATION_FAILED');
  });
});

describe('input validation', () => {
  it('rejects unknown properties such as an injected tenantId', () => {
    const schema = z.object({ name: z.string() }).strict();
    expect(() => parseInput(schema, { name: 'x', tenantId: 'y' }, 'body')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });
});

describe('idempotency hashing', () => {
  it('hashes semantically equal bodies identically regardless of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });
});

describe('keyset pagination', () => {
  it('round-trips cursors and rejects tampered ones', () => {
    const cursor = encodeCursor(['2026-01-01T00:00:00.123456+00:00', 'abc']);
    expect(decodeCursor(cursor, z.tuple([z.string(), z.string()]))).toEqual(['2026-01-01T00:00:00.123456+00:00', 'abc']);
    expect(() => decodeCursor('not-a-cursor', z.tuple([z.string(), z.string()]))).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('uses the extra row only to signal the next page', () => {
    const page = toPage([1, 2, 3], 2, (n) => n * 10, (n) => [n]);
    expect(page.data).toEqual([10, 20]);
    expect(page.page.nextCursor).toBe(encodeCursor([2]));
    expect(toPage([1, 2], 2, (n) => n, (n) => [n]).page.nextCursor).toBeNull();
  });
});
