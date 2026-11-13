import type { Router } from 'express';
import { JsonCache, createCacheConnection } from '@medicitas/cache';
import type { Logger } from '@medicitas/observability';
import { createServiceInfrastructure, serveHttp, type RunningService } from '@medicitas/runtime';
import type { SchedulerConfig } from './config.js';
import { AvailabilityCache } from './infrastructure/cache/availability-cache.js';
import { HoldExpirySweeper } from './infrastructure/workers/hold-expiry-sweeper.js';
import { schedulerHandlers } from './interfaces/messaging/handlers.js';
import { appointmentRoutes } from './interfaces/http/appointment-routes.js';
import { readRoutes } from './interfaces/http/read-routes.js';
import { scheduleRoutes } from './interfaces/http/schedule-routes.js';

export interface SchedulerService extends RunningService {
  readonly sweeper: HoldExpirySweeper;
}

/** Composition root of scheduler-management (database medicitas_scheduler, Redis availability cache). */
export async function startScheduler(config: SchedulerConfig, options: { readonly logger?: Logger } = {}): Promise<SchedulerService> {
  const infrastructure = await createServiceInfrastructure('scheduler-management', config, {
    workerDbRole: 'sch_worker',
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const { pool, publisher, logger, lifecycle } = infrastructure;

  let jsonCache: JsonCache | null = null;
  if (config.redis !== null) {
    const connection = createCacheConnection(config.redis, logger);
    // A cache that cannot connect at startup must not stop the service: reads bypass to PostgreSQL.
    connection.connect().catch((error: unknown) => logger.warn({ err: (error as Error).message }, 'redis connect failed; bypassing cache'));
    // destroy() also stops background reconnection attempts when Redis was never reachable.
    lifecycle.onShutdown('redis', async () => connection.destroy());
    jsonCache = new JsonCache(connection, logger);
  }
  const cache = new AvailabilityCache(jsonCache, config.cacheTtlSeconds, logger);

  await infrastructure.startConsumers(
    schedulerHandlers({ service: 'scheduler-management', pool, publisher, logger, systemDbRole: 'sch_system' }, cache),
  );

  const sweeper = new HoldExpirySweeper(pool, cache, logger, config.holdSweepIntervalMs);
  sweeper.start();
  lifecycle.onShutdown('hold sweeper', () => sweeper.stop());

  const deps = { pool, cache, logger };
  const routes = (router: Router): void => {
    scheduleRoutes(deps)(router);
    appointmentRoutes(deps)(router);
    readRoutes(deps)(router);
  };
  const running = await serveHttp(infrastructure, routes, config.port);
  return { ...running, sweeper };
}
