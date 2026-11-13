import type { Request, Response, Router } from 'express';
import { DependencyUnavailableError } from '@medicitas/kernel';
import { requirePermission, requireTenant, type TenantContext } from '@medicitas/identity';
import type { Logger } from '@medicitas/observability';
import { contextOf, problem, sendData } from '@medicitas/runtime';
import { matchRoute, type RouteDefinition, type Upstream } from '../../domain/route-table.js';

export interface GatewaySettings {
  readonly upstreams: Readonly<Record<Upstream, string>>;
  /** Longer than the 8 s synchronous wait of the saga routes. */
  readonly upstreamTimeoutMs: number;
}

/** Request headers forwarded to services; everything else (incl. X-Tenant-*, X-User-*) is dropped. */
const FORWARDED_REQUEST_HEADERS = ['authorization', 'content-type', 'idempotency-key', 'accept'];
/** Response headers copied back to the client. */
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'location', 'x-cache', 'idempotent-replayed', 'retry-after', 'www-authenticate'];

function authorize(context: TenantContext, route: RouteDefinition): void {
  if (route.access === 'authenticated') return;
  if (route.access === 'clinic-user') {
    requireTenant(context);
    return;
  }
  requirePermission(context, ...route.access);
}

/** RF17 at the edge: authentication (401), coarse permission (403) and forwarding to the owner. */
export function gatewayRoutes(settings: GatewaySettings, logger: Logger) {
  async function forward(req: Request, res: Response, upstream: Upstream): Promise<void> {
    const headers: Record<string, string> = { 'X-Correlation-Id': res.locals.correlationId };
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.get(name);
      if (value !== undefined) headers[name] = value;
    }
    // Forward a body only when the client actually sent one: a body-less POST (e.g. deactivate) may
    // arrive with "Content-Length: 0" and no Content-Type, and must reach the service body-less too.
    const contentLength = req.get('Content-Length');
    const clientSentBody = contentLength !== undefined ? Number(contentLength) > 0 : req.get('Transfer-Encoding') !== undefined;
    const hasBody = clientSentBody && req.body !== undefined && req.method !== 'GET' && req.method !== 'DELETE';
    if (!hasBody) delete headers['content-type'];
    let response: globalThis.Response;
    try {
      response = await fetch(`${settings.upstreams[upstream]}${req.originalUrl}`, {
        method: req.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(req.body) } : {}),
        signal: AbortSignal.timeout(settings.upstreamTimeoutMs),
      });
    } catch (error) {
      logger.warn({ upstream, err: (error as Error).message }, 'upstream unavailable');
      throw new DependencyUnavailableError(upstream, error);
    }
    res.status(response.status);
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) res.setHeader(name, value);
    }
    const body = await response.text();
    if (body === '') res.end();
    else res.send(body);
  }

  return (router: Router): void => {
    router.use('/api', async (req, res) => {
      const match = matchRoute(req.method, req.baseUrl + req.path);
      if (match.kind === 'not-found') {
        const body = problem(404, 'ROUTE_NOT_FOUND', `No route for ${req.method} ${req.originalUrl.split('?')[0] ?? ''}.`, res.locals.correlationId);
        res.status(404).type('application/problem+json').json(body.body);
        return;
      }
      if (match.kind === 'method-not-allowed') {
        res.setHeader('Allow', [...new Set(match.allowed)].join(', '));
        const body = problem(405, 'METHOD_NOT_ALLOWED', `Method ${req.method} is not allowed on this resource.`, res.locals.correlationId);
        res.status(405).type('application/problem+json').json(body.body);
        return;
      }
      const context = contextOf(res);
      authorize(context, match.route);
      if (match.route.upstream === null) {
        // GET /api/v1/me (RF17): helps verify tokens and the tenant mapping; never echoes the token.
        sendData(res, 200, { subject: context.subject, tenantId: context.tenantId, roles: context.roles, permissions: [...context.permissions].sort() });
        return;
      }
      await forward(req, res, match.route.upstream);
    });
  };
}
