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
import { onboardingHooks } from './application/onboarding-saga.js';
import { onboardingRoutes, type HttpSettings } from './interfaces/http/routes.js';
import { replyHandlers } from './interfaces/messaging/replies.js';

export interface OnboardingConfig extends ServiceConfig {
  readonly keycloakAdmin: KeycloakAdminConfig;
  readonly saga: HttpSettings & { readonly sweepIntervalMs: number; readonly localRetryMs: number };
}

const envSchema = serviceEnvSchema.extend({
  KEYCLOAK_ADMIN_URL: z.url(),
  KEYCLOAK_REALM: z.string().min(1).default('medicitas'),
  KEYCLOAK_PROVISIONER_CLIENT_ID: z.string().min(1).default('medicitas-provisioner'),
  KEYCLOAK_PROVISIONER_CLIENT_SECRET: z.string().min(8),
  KEYCLOAK_ADMIN_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  ONBOARDING_DEADLINE_MS: z.coerce.number().int().min(5_000).default(120_000),
  SAGA_SYNC_WAIT_MS: z.coerce.number().int().min(0).max(30_000).default(8_000),
  SAGA_RESEND_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  SAGA_SWEEP_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(500),
});

export function onboardingConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): OnboardingConfig {
  const parsed = parseConfig(envSchema, env);
  return {
    ...serviceConfigFromEnv(parsed, 'onboarding-orchestrator'),
    keycloakAdmin: {
      baseUrl: parsed.KEYCLOAK_ADMIN_URL,
      realm: parsed.KEYCLOAK_REALM,
      clientId: parsed.KEYCLOAK_PROVISIONER_CLIENT_ID,
      clientSecret: parsed.KEYCLOAK_PROVISIONER_CLIENT_SECRET,
      timeoutMs: parsed.KEYCLOAK_ADMIN_TIMEOUT_MS,
    },
    saga: {
      deadlineMs: parsed.ONBOARDING_DEADLINE_MS,
      syncWaitMs: parsed.SAGA_SYNC_WAIT_MS,
      resendMs: parsed.SAGA_RESEND_INTERVAL_MS,
      convergeWindowMs: parsed.ONBOARDING_DEADLINE_MS,
      compensationWindowMs: 30_000,
      sweepIntervalMs: parsed.SAGA_SWEEP_INTERVAL_MS,
      localRetryMs: 2_000,
    },
  };
}

const TABLES: SagaTables = { tenantScoped: false, workerRole: 'onb_worker', systemRole: 'onb_system' };

/** Composition root of onboarding-orchestrator (control plane, database medicitas_onboarding). */
export async function startOnboarding(config: OnboardingConfig, options: { readonly logger?: Logger } = {}): Promise<RunningService> {
  const infrastructure = await createServiceInfrastructure('onboarding-orchestrator', config, {
    workerDbRole: 'onb_worker',
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const { pool, publisher, logger, lifecycle } = infrastructure;
  const secrets = new EphemeralSecrets(config.saga.deadlineMs);
  lifecycle.onShutdown('secrets', async () => secrets.clear());
  const hooks = onboardingHooks(new KeycloakAdminClient(config.keycloakAdmin), secrets, config.saga, logger);
  const runner = new SagaRunner(
    pool,
    TABLES,
    hooks,
    { resendMs: config.saga.resendMs, localRetryMs: config.saga.localRetryMs, leaseMs: 30_000, sweepIntervalMs: config.saga.sweepIntervalMs },
    logger,
  );
  await infrastructure.startConsumers(
    replyHandlers({ service: 'onboarding-orchestrator', pool, publisher, logger, systemDbRole: 'onb_system' }, TABLES, hooks, runner, config.saga),
  );
  runner.start();
  lifecycle.onShutdown('saga runner', () => runner.stop());
  return serveHttp(infrastructure, onboardingRoutes(pool, TABLES, secrets, config.saga), config.port);
}
