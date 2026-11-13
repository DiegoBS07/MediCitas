import { z } from 'zod';
import { parseConfig } from '@medicitas/kernel';
import type { Logger } from '@medicitas/observability';
import { createServiceInfrastructure, serveHttp, serviceConfigFromEnv, serviceEnvSchema, type RunningService, type ServiceConfig } from '@medicitas/runtime';
import { bookingRoutes, type BookingHttpSettings } from './interfaces/http/routes.js';
import { replyHandlers } from './interfaces/messaging/reply-handlers.js';
import { SagaSweeper } from './infrastructure/workers/saga-sweeper.js';
import { SagaWaiter } from './infrastructure/workers/saga-waiter.js';

export interface AppointmentOrchestratorConfig extends ServiceConfig {
  readonly saga: BookingHttpSettings;
  readonly sweepIntervalMs: number;
}

const envSchema = serviceEnvSchema.extend({
  APPOINTMENT_SAGA_DEADLINE_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  APPOINTMENT_SYNC_WAIT_MS: z.coerce.number().int().min(0).max(30_000).default(8_000),
  SAGA_RESEND_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  SAGA_COMPENSATION_WINDOW_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  SAGA_SWEEP_INTERVAL_MS: z.coerce.number().int().min(200).max(60_000).default(1_000),
});

export function appointmentOrchestratorConfigFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): AppointmentOrchestratorConfig {
  const parsed = parseConfig(envSchema, env);
  return {
    ...serviceConfigFromEnv(parsed, 'appointment-orchestrator'),
    saga: {
      deadlineMs: parsed.APPOINTMENT_SAGA_DEADLINE_MS,
      syncWaitMs: parsed.APPOINTMENT_SYNC_WAIT_MS,
      resendMs: parsed.SAGA_RESEND_INTERVAL_MS,
      compensationWindowMs: parsed.SAGA_COMPENSATION_WINDOW_MS,
    },
    sweepIntervalMs: parsed.SAGA_SWEEP_INTERVAL_MS,
  };
}

export interface AppointmentOrchestratorService extends RunningService {
  readonly sweeper: SagaSweeper;
}

/** Composition root of appointment-orchestrator (database medicitas_appointment_orchestrator). */
export async function startAppointmentOrchestrator(
  config: AppointmentOrchestratorConfig,
  options: { readonly logger?: Logger } = {},
): Promise<AppointmentOrchestratorService> {
  const infrastructure = await createServiceInfrastructure('appointment-orchestrator', config, {
    workerDbRole: 'ao_worker',
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const { pool, publisher, logger, lifecycle } = infrastructure;

  const waiter = new SagaWaiter(pool, logger);
  await waiter.start();
  lifecycle.onShutdown('saga waiter', () => waiter.stop());

  await infrastructure.startConsumers(
    replyHandlers({ service: 'appointment-orchestrator', pool, publisher, logger, systemDbRole: 'ao_system' }, config.saga),
  );

  // Recovery after a restart: the first sweep runs immediately (re-sends, deadlines).
  const sweeper = new SagaSweeper(pool, config.saga, logger, config.sweepIntervalMs);
  sweeper.start();
  lifecycle.onShutdown('saga sweeper', () => sweeper.stop());

  const running = await serveHttp(infrastructure, bookingRoutes(pool, waiter, config.saga), config.port);
  return { ...running, sweeper };
}
