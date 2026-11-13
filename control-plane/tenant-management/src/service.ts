import { createServiceInfrastructure, serveHttp, type RunningService, type ServiceConfig } from '@medicitas/runtime';
import type { Logger } from '@medicitas/observability';
import { COMMANDS_QUEUE, tenantCommandHandlers } from './interfaces/messaging/command-handlers.js';
import { tenantRoutes } from './interfaces/http/routes.js';

/** Composition root of tenant-management (control plane, database medicitas_tenant). */
export async function startTenantManagement(config: ServiceConfig, options: { readonly logger?: Logger } = {}): Promise<RunningService> {
  const infrastructure = await createServiceInfrastructure('tenant-management', config, {
    workerDbRole: 'tm_worker',
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const { pool, publisher, logger } = infrastructure;
  await infrastructure.startConsumers({
    [COMMANDS_QUEUE]: tenantCommandHandlers({ service: 'tenant-management', pool, publisher, logger, systemDbRole: 'tm_system' }),
  });
  return serveHttp(infrastructure, tenantRoutes(pool), config.port);
}
