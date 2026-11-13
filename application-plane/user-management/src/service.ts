import { createServiceInfrastructure, serveHttp, type RunningService, type ServiceConfig } from '@medicitas/runtime';
import type { Logger } from '@medicitas/observability';
import { userManagementHandlers } from './interfaces/messaging/handlers.js';
import { userManagementRoutes } from './interfaces/http/routes.js';

/** Composition root of user-management (database medicitas_user). */
export async function startUserManagement(config: ServiceConfig, options: { readonly logger?: Logger } = {}): Promise<RunningService> {
  const infrastructure = await createServiceInfrastructure('user-management', config, {
    workerDbRole: 'um_worker',
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const { pool, publisher, logger } = infrastructure;
  await infrastructure.startConsumers(
    userManagementHandlers({ service: 'user-management', pool, publisher, logger, systemDbRole: 'um_system' }),
  );
  return serveHttp(infrastructure, userManagementRoutes(pool), config.port);
}
