import { httpStatusFor, isAppError, type ErrorDetail } from '@medicitas/kernel';

/** RFC 9457 problem document. */
export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly correlationId: string;
  readonly errors?: readonly ErrorDetail[];
  readonly details?: Readonly<Record<string, string>>;
}

export interface Problem {
  readonly status: number;
  readonly body: ProblemBody;
  /** Seconds, for 503 responses. */
  readonly retryAfterSeconds?: number;
}

/** Errors raised by Express' JSON body parser carry a `type` and an HTTP `status`. */
interface BodyParserError {
  readonly type?: unknown;
  readonly status?: unknown;
}

function titleOf(code: string): string {
  const words = code.toLowerCase().split('_');
  const sentence = words.join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export function problem(
  status: number,
  code: string,
  detail: string,
  correlationId: string,
  extra: { readonly errors?: readonly ErrorDetail[]; readonly details?: Readonly<Record<string, string>> } = {},
): Problem {
  return {
    status,
    body: {
      type: `urn:medicitas:problem:${code.toLowerCase().replaceAll('_', '-')}`,
      title: titleOf(code),
      status,
      code,
      detail,
      correlationId,
      ...(extra.errors !== undefined && extra.errors.length > 0 ? { errors: extra.errors } : {}),
      ...(extra.details !== undefined && Object.keys(extra.details).length > 0 ? { details: extra.details } : {}),
    },
    ...(status === 503 ? { retryAfterSeconds: 2 } : {}),
  };
}

/**
 * Maps any error to a problem document. Unknown errors become 500 INTERNAL_ERROR with a generic
 * message: stack traces, SQL and data from other tenants never reach the client.
 */
export function toProblem(error: unknown, correlationId: string): Problem {
  if (isAppError(error)) {
    return problem(httpStatusFor(error), error.code, error.message, correlationId, {
      errors: error.details,
      details: error.meta,
    });
  }
  if (typeof error === 'object' && error !== null) {
    const parserError = error as BodyParserError;
    switch (parserError.type) {
      case 'entity.too.large':
        return problem(413, 'PAYLOAD_TOO_LARGE', 'The request body exceeds 64 KB.', correlationId);
      case 'entity.parse.failed':
        return problem(400, 'VALIDATION_FAILED', 'The request body is not valid JSON.', correlationId);
      case 'encoding.unsupported':
      case 'charset.unsupported':
        return problem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only UTF-8 JSON bodies are accepted.', correlationId);
      default:
        break;
    }
  }
  return problem(500, 'INTERNAL_ERROR', 'Unexpected error. Quote the correlationId when reporting it.', correlationId);
}
