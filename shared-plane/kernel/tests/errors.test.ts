import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  AuthorizationError,
  BusinessRuleError,
  ConcurrencyConflictError,
  ConflictError,
  DependencyUnavailableError,
  NotFoundError,
  ValidationError,
  httpStatusFor,
  isConnectionError,
  isRetryableTransactionError,
  isUuid,
  pgErrorInfo,
} from '../src/index.js';

describe('error model → HTTP status (api-contracts §1.5)', () => {
  it.each([
    [new ValidationError('bad'), 400, 'VALIDATION_FAILED'],
    [new AuthenticationError('AUTHENTICATION_REQUIRED', 'none'), 401, 'AUTHENTICATION_REQUIRED'],
    [new AuthorizationError(), 403, 'FORBIDDEN'],
    [new NotFoundError('appointment'), 404, 'RESOURCE_NOT_FOUND'],
    [new ConflictError('SLOT_TAKEN', 'taken'), 409, 'SLOT_TAKEN'],
    [new ConcurrencyConflictError(), 409, 'CONCURRENCY_CONFLICT'],
    [new BusinessRuleError('OUTSIDE_WORKING_HOURS', 'no'), 422, 'OUTSIDE_WORKING_HOURS'],
    [new DependencyUnavailableError('redis'), 503, 'DEPENDENCY_UNAVAILABLE'],
  ])('%s → %i %s', (error, status, code) => {
    expect(httpStatusFor(error)).toBe(status);
    expect(error.code).toBe(code);
  });

  it('marks dependency and concurrency errors as retryable', () => {
    expect(new DependencyUnavailableError('db').retryable).toBe(true);
    expect(new ConcurrencyConflictError().retryable).toBe(true);
    expect(new ValidationError('x').retryable).toBe(false);
  });
});

describe('PostgreSQL error classification (ADR-0007)', () => {
  it('extracts SQLSTATE and constraint names', () => {
    expect(pgErrorInfo({ code: '23P01', constraint: 'appointments_no_professional_overlap', message: 'x' })).toEqual({
      sqlState: '23P01',
      constraint: 'appointments_no_professional_overlap',
      message: 'x',
    });
  });

  it('retries serialization failures, deadlocks and lock timeouts — never business violations', () => {
    expect(isRetryableTransactionError({ code: '40001' })).toBe(true);
    expect(isRetryableTransactionError({ code: '40P01' })).toBe(true);
    expect(isRetryableTransactionError({ code: '55P03' })).toBe(true);
    expect(isRetryableTransactionError({ code: '23P01' })).toBe(false);
    expect(isRetryableTransactionError({ code: '23505' })).toBe(false);
  });

  it('recognises connection failures', () => {
    expect(isConnectionError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isConnectionError({ code: '57P01' })).toBe(true);
    expect(isConnectionError({ code: '08006' })).toBe(true);
    expect(isConnectionError({ code: '23505' })).toBe(false);
  });
});

describe('isUuid', () => {
  it('accepts canonical lowercase UUIDs (including the deterministic seed ids) and rejects the rest', () => {
    expect(isUuid('10000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isUuid('10000000-0000-4000-8000-00000000000G')).toBe(false);
    expect(isUuid('4b8a6f0e-2f8e-4b8e-9a51-0f8d0f3c2a11')).toBe(true);
    expect(isUuid('4B8A6F0E-2F8E-4B8E-9A51-0F8D0F3C2A11')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});
