import { z } from 'zod';
import { parseConfig } from '@medicitas/kernel';
import { EphemeralSecrets, KeycloakAdminClient, type KeycloakAdminConfig } from '@medicitas/identity';
import type { Logger } from '@medicitas/observability';
import {
  SagaRunner,
  createServiceInfrastructure,
  serveHttp,
  serviceConfigFromEnv,
  serviceEnvSchema,
  type RunningService,
  type SagaTables,
  type ServiceConfig,
} from '@medicitas/runtime';
import { provisioningHooks } from './application/provisioning-saga.js';
import { provisioningRoutes, type HttpSettings } from './interfaces/http/routes.js';
import { replyHandlers } from './interfaces/messaging/replies.js';

export interface UserOrchestratorConfig extends ServiceConfig {
  readonly keycloakAdmin: KeycloakAdminConfig;
  readonly saga: HttpSettings & { readonly sweepIntervalMs: number; readonly localRetryMs: number };
}

/** Keycloak Admin settings shared by both provisioning orchestrators (ADR-0012). */
export const keycloakAdminEnvSchema = serviceEnvSchema.extend({
  KEYCLOAK_ADMIN_URL: z.url(),
  KEYCLOAK_REALM: z.string().min(1).default('medicitas'),
  KEYCLOAK_PROVISIONER_CLIENT_ID: z.string().min(1).default('medicitas-provisioner'),
  KEYCLOAK_PROVISIONER_CLIENT_SECRET: z.string().min(8),
  KEYCLOAK_ADMIN_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  SAGA_SYNC_WAIT_MS: z.coerce.number().int().min(0).max(30_000).default(8_000),
  SAGA_RESEND_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  SAGA_SWEEP_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(500),
});

export function userOrchestratorConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): UserOrchestratorConfig {
  const parsed = parseConfig(keycloakAdminEnvSchema.extend({ USER_PROVISIONING_DEADLINE_MS: z.coerce.number().int().min(5_000).default(60_000) }), env);
  return {
    ...serviceConfigFromEnv(parsed, 'user-management-orchestrator'),
    keycloakAdmin: {
      baseUrl: parsed.KEYCLOAK_ADMIN_URL,
      realm: parsed.KEYCLOAK_REALM,
      clientId: parsed.KEYCLOAK_PROVISIONER_CLIENT_ID,
      clientSecret: parsed.KEYCLOAK_PROVISIONER_CLIENT_SECRET,
      timeoutMs: parsed.KEYCLOAK_ADMIN_TIMEOUT_MS,
    },
    saga: {
      deadlineMs: parsed.USER_PROVISIONING_DEADLINE_MS,
      syncWaitMs: parsed.SAGA_SYNC_WAIT_MS,
      resendMs: parsed.SAGA_RESEND_INTERVAL_MS,
      convergeWindowMs: parsed.USER_PROVISIONING_DEADLINE_MS,
      compensationWindowMs: 30_000,
      sweepIntervalMs: parsed.SAGA_SWEEP_INTERVAL_MS,
      localRetryMs: 2_000,
    },
  };
}

const TABLES: SagaTables = { tenantScoped: true, workerRole: 'umo_worker', systemRole: 'umo_system' };

/** Composition root of user-management-orchestrator (database medicitas_user_orchestrator). */
export async function startUserOrchestrator(config: UserOrchestratorConfig, options: { readonly logger?: Logger } = {}): Promise<RunningService> {
  const infrastructure = await createServiceInfrastructure('user-management-orchestrator', config, {
    workerDbRole: 'umo_worker',
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const { pool, publisher, logger, lifecycle } = infrastructure;
  const secrets = new EphemeralSecrets(config.saga.deadlineMs);
  lifecycle.onShutdown('secrets', async () => secrets.clear());
  const keycloak = new KeycloakAdminClient(config.keycloakAdmin);
  const hooks = provisioningHooks(keycloak, secrets, config.saga, logger);
  const runner = new SagaRunner(
    pool,
    TABLES,
    hooks,
    { resendMs: config.saga.resendMs, localRetryMs: config.saga.localRetryMs, leaseMs: 30_000, sweepIntervalMs: config.saga.sweepIntervalMs },
    logger,
  );
  await infrastructure.startConsumers(
    replyHandlers({ service: 'user-management-orchestrator', pool, publisher, logger, systemDbRole: 'umo_system' }, TABLES, hooks, runner),
  );
  runner.start();
  lifecycle.onShutdown('saga runner', () => runner.stop());
  return serveHttp(infrastructure, provisioningRoutes(pool, TABLES, secrets, config.saga), config.port);
}
