import { randomUUID } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';
import { AuthenticationError, isUuid, type DatabaseClient, type IsolationLevel, type TransactionContext } from '@medicitas/kernel';
import { requireTenant, type JwtVerifier, type Role, type TenantContext } from '@medicitas/identity';
import { requestEventSink, type ActorRole, type EventSink, type ServiceName } from '@medicitas/messaging';
import { runHealthChecks, runWithLogContext, type HealthCheck, type Logger } from '@medicitas/observability';
import { problem, toProblem } from './problem.js';
import type { IdempotentOutcome } from './idempotency.js';

declare global {
  namespace Express {
    interface Locals {
      correlationId: string;
      tenantContext?: TenantContext;
    }
  }
}

export interface HttpAppOptions {
  readonly logger: Logger;
  readonly health: readonly HealthCheck[];
  /** Verifies the bearer token of every /api route (each service re-validates; ADR-0002). */
  readonly verifier: JwtVerifier;
  readonly routes: (router: Router) => void;
}

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
/** Client headers that try to impersonate a tenant, user or role are dropped (api-contracts §1.2). */
const SPOOFING_HEADER = /^x-(tenant|user|role|actor)/i;

/**
 * Express application with the conventions of api-contracts §1: correlation id, JSON-only bodies
 * (64 KB), authentication on /api, problem+json errors and unauthenticated health endpoints.
 */
export function createHttpApp(options: HttpAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.set('query parser', 'simple');

  app.use(correlation(options.logger));
  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  app.get('/health/ready', async (_req, res) => {
    const report = await runHealthChecks(options.health);
    if (report.status !== 'ok') options.logger.warn({ checks: report.checks }, 'readiness degraded');
    res.status(report.status === 'ok' ? 200 : 503).json({ status: report.status });
  });

  app.use(requireJsonBody);
  app.use(express.json({ limit: '64kb', strict: true, type: () => true }));
  app.use('/api', authenticate(options.verifier));

  const router = express.Router();
  options.routes(router);
  app.use(router);

  app.use((req, res) => {
    const body = problem(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}.`, res.locals.correlationId);
    res.status(body.status).type('application/problem+json').json(body.body);
  });
  app.use(errorHandler(options.logger));
  return app;
}

function correlation(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const header = req.get('X-Correlation-Id');
    const correlationId = header !== undefined && isUuid(header.toLowerCase()) ? header.toLowerCase() : randomUUID();
    res.locals.correlationId = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);
    for (const name of Object.keys(req.headers)) {
      if (SPOOFING_HEADER.test(name)) delete req.headers[name];
    }
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.path.startsWith('/health/')) return;
      logger.info(
        {
          correlationId,
          method: req.method,
          route: req.route === undefined ? req.path : String((req.route as { path: unknown }).path),
          status: res.statusCode,
          durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        },
        'http request',
      );
    });
    runWithLogContext({ correlationId }, () => next());
  };
}

function requireJsonBody(req: Request, res: Response, next: NextFunction): void {
  const hasBody = req.get('Content-Length') !== undefined ? Number(req.get('Content-Length')) > 0 : req.get('Transfer-Encoding') !== undefined;
  if (BODY_METHODS.has(req.method) && hasBody && !req.is('application/json')) {
    const body = problem(415, 'UNSUPPORTED_MEDIA_TYPE', 'Only application/json bodies are accepted.', res.locals.correlationId);
    res.status(415).type('application/problem+json').json(body.body);
    return;
  }
  next();
}

function authenticate(verifier: JwtVerifier): RequestHandler {
  return async (req, res, next) => {
    const context = await verifier.verifyAuthorizationHeader(req.get('Authorization'), res.locals.correlationId);
    res.locals.tenantContext = context;
    runWithLogContext(context.tenantId === null ? {} : { tenantId: context.tenantId }, () => next());
  };
}

function errorHandler(logger: Logger) {
  return (error: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const result = toProblem(error, res.locals.correlationId);
    if (result.status >= 500) {
      logger.error(
        { err: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error), code: result.body.code },
        'request failed',
      );
    }
    if (result.status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="medicitas"');
    if (result.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(result.retryAfterSeconds));
    res.status(result.status).type('application/problem+json').json(result.body);
  };
}

/** The verified TenantContext of the request (only available under /api). */
export function contextOf(res: Response): TenantContext {
  const context = res.locals.tenantContext;
  if (context === undefined) throw new AuthenticationError('AUTHENTICATION_REQUIRED', 'A bearer access token is required.');
  return context;
}

/** Envelope actor for messages caused by this request (messaging-contracts §4). */
export function messageActor(context: TenantContext): { readonly subject: string; readonly roles: ActorRole[] } {
  return { subject: context.subject, roles: [...context.roles] };
}

const ROLE_SUFFIX: Readonly<Record<Role, string>> = {
  platform_admin: 'platform_admin',
  clinic_admin: 'clinic_admin',
  receptionist: 'receptionist',
  health_professional: 'professional',
};

/** Database actor role of the caller (ADR-0009), e.g. ("sch", receptionist) → sch_receptionist. */
export function dbRoleOf(prefix: string, context: TenantContext): string {
  return `${prefix}_${ROLE_SUFFIX[context.role]}`;
}

export function sendData(res: Response, status: number, data: unknown, headers: Readonly<Record<string, string>> = {}): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.status(status).json({ data });
}

/** Sends a (possibly replayed) idempotent response; replays carry Idempotent-Replayed: true. */
export function sendOutcome(res: Response, outcome: IdempotentOutcome, headers: Readonly<Record<string, string>> = {}): void {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  if (outcome.replayed) res.setHeader('Idempotent-Replayed', 'true');
  const body = outcome.response.body;
  const isProblem = outcome.response.status >= 400;
  res.status(outcome.response.status);
  if (isProblem) res.type('application/problem+json');
  res.json(body);
}

/**
 * Transaction context of a tenant-scoped request (ADR-0004/0009): tenant from the verified token
 * only, the caller's subject, and the caller's DB actor role. A platform token gets 403 here.
 */
export function tenantTransaction(
  prefix: string,
  context: TenantContext,
  options: { readonly readOnly?: boolean; readonly isolation?: IsolationLevel } = {},
): TransactionContext {
  return {
    tenantId: requireTenant(context),
    actorSubject: context.subject,
    dbRole: dbRoleOf(prefix, context),
    isolation: options.isolation ?? 'READ COMMITTED',
    ...(options.readOnly === true ? { readOnly: true } : {}),
  };
}

/** Outbox-backed EventSink for events caused by this request. */
export function requestEvents(client: DatabaseClient, service: ServiceName, context: TenantContext): EventSink {
  return requestEventSink(client, {
    producer: service,
    tenantId: context.tenantId,
    actor: messageActor(context),
    correlationId: context.correlationId,
  });
}
