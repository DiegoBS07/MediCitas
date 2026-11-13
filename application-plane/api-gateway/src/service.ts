import { z } from 'zod';
import { parseConfig } from '@medicitas/kernel';
import { createJwtVerifier, type JwtVerifierConfig } from '@medicitas/identity';
import { createLogger, type Logger } from '@medicitas/observability';
import { Lifecycle, closeServer, createHttpApp, listen, type RunningService } from '@medicitas/runtime';
import { UPSTREAMS, type Upstream } from './domain/route-table.js';
import { gatewayRoutes, type GatewaySettings } from './interfaces/http/gateway-routes.js';

export interface GatewayConfig extends GatewaySettings {
  readonly port: number;
  readonly logLevel: string;
  readonly identity: JwtVerifierConfig;
}

const URL_ENV: Readonly<Record<Upstream, string>> = {
  'tenant-management': 'TENANT_MANAGEMENT_URL',
  'onboarding-orchestrator': 'ONBOARDING_ORCHESTRATOR_URL',
  'user-management': 'USER_MANAGEMENT_URL',
  'user-management-orchestrator': 'USER_MANAGEMENT_ORCHESTRATOR_URL',
  'catalog-service-management': 'CATALOG_SERVICE_URL',
  'scheduler-management': 'SCHEDULER_URL',
  'appointment-orchestrator': 'APPOINTMENT_ORCHESTRATOR_URL',
};

const envSchema = z.object({
  SERVICE_PORT: z.coerce.number().int().min(0).max(65_535).default(8000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  KEYCLOAK_JWKS_URL: z.url(),
  KEYCLOAK_PUBLIC_ISSUER: z.url(),
  KEYCLOAK_AUDIENCE: z.string().min(1).default('medicitas-api'),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(20_000),
  ...Object.fromEntries(Object.values(URL_ENV).map((name) => [name, z.url()])),
});

export function gatewayConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): GatewayConfig {
  const parsed = parseConfig(envSchema, env) as z.infer<typeof envSchema> & Record<string, string>;
  return {
    port: parsed.SERVICE_PORT,
    logLevel: parsed.LOG_LEVEL,
    identity: { jwksUrl: parsed.KEYCLOAK_JWKS_URL, issuer: parsed.KEYCLOAK_PUBLIC_ISSUER, audience: parsed.KEYCLOAK_AUDIENCE },
    upstreamTimeoutMs: parsed.UPSTREAM_TIMEOUT_MS,
    upstreams: Object.fromEntries(UPSTREAMS.map((upstream) => [upstream, String(parsed[URL_ENV[upstream]]).replace(/\/$/, '')])) as Record<Upstream, string>,
  };
}

/**
 * Composition root of the API gateway: stateless (no database, no broker), so it scales by simply
 * adding instances. Readiness = the identity provider keys are reachable.
 */
export async function startGateway(config: GatewayConfig, options: { readonly logger?: Logger } = {}): Promise<RunningService> {
  const logger = options.logger ?? createLogger({ service: 'api-gateway', level: config.logLevel });
  const lifecycle = new Lifecycle(logger);
  const verifier = createJwtVerifier(config.identity);
  const app = createHttpApp({
    logger,
    verifier,
    health: [
      {
        name: 'identity-provider',
        check: async () => {
          const response = await fetch(config.identity.jwksUrl, { signal: AbortSignal.timeout(1_500) });
          if (!response.ok) throw new Error(`JWKS HTTP ${response.status}`);
        },
      },
    ],
    routes: gatewayRoutes(config, logger),
  });
  const { server, port } = await listen(app, config.port);
  lifecycle.onShutdown('http', () => closeServer(server));
  logger.info({ port }, 'api-gateway started');
  return { port, logger, stop: () => lifecycle.shutdown() };
}
