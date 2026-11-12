/**
 * Application error model shared by every service.
 *
 * Every error carries a stable `code` (documented in docs/contracts/api-contracts.md §1.5)
 * and a `category` that maps to an HTTP status and to a messaging classification.
 */
export type ErrorCategory =
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'not_found'
  | 'conflict'
  | 'business_rule'
  | 'dependency'
  | 'internal';

export interface ErrorDetail {
  readonly path: string;
  readonly message: string;
}

export interface AppErrorOptions {
  readonly details?: readonly ErrorDetail[];
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly details: readonly ErrorDetail[];
  readonly retryable: boolean;

  constructor(category: ErrorCategory, code: string, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.category = category;
    this.code = code;
    this.details = options.details ?? [];
    this.retryable = options.retryable ?? category === 'dependency';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details: readonly ErrorDetail[] = [], code = 'VALIDATION_FAILED') {
    super('validation', code, message, { details });
  }
}

export class AuthenticationError extends AppError {
  constructor(code: 'AUTHENTICATION_REQUIRED' | 'TOKEN_INVALID', message: string, cause?: unknown) {
    super('authentication', code, message, { cause });
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'The caller is not allowed to perform this operation.') {
    super('authorization', 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  readonly resource: string;

  constructor(resource: string, message = `${resource} not found.`) {
    super('not_found', 'RESOURCE_NOT_FOUND', message);
    this.resource = resource;
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super('conflict', code, message, options);
  }
}

export class BusinessRuleError extends AppError {
  constructor(code: string, message: string, options: AppErrorOptions = {}) {
    super('business_rule', code, message, options);
  }
}

export class DependencyUnavailableError extends AppError {
  constructor(dependency: string, cause?: unknown, code = 'DEPENDENCY_UNAVAILABLE') {
    super('dependency', code, `Dependency temporarily unavailable: ${dependency}.`, { cause, retryable: true });
  }
}

export class ConcurrencyConflictError extends AppError {
  constructor(cause?: unknown) {
    super('conflict', 'CONCURRENCY_CONFLICT', 'The operation conflicted with a concurrent one; retry it.', {
      cause,
      retryable: true,
    });
  }
}

const HTTP_STATUS_BY_CATEGORY: Readonly<Record<ErrorCategory, number>> = {
  validation: 400,
  authentication: 401,
  authorization: 403,
  not_found: 404,
  conflict: 409,
  business_rule: 422,
  dependency: 503,
  internal: 500,
};

export function httpStatusFor(error: AppError): number {
  return HTTP_STATUS_BY_CATEGORY[error.category];
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
