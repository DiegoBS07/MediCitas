import { createServiceInfrastructure, serveHttp, type RunningService, type ServiceConfig } from '@medicitas/runtime';
import type { Logger } from '@medicitas/observability';
import { catalogHandlers } from './interfaces/messaging/handlers.js';
import { catalogRoutes } from './interfaces/http/routes.js';
import { RabbitUserDirectory } from './infrastructure/messaging/user-directory.js';

/** Composition root of catalog-service-management (database medicitas_catalog). */
export async function startCatalogService(config: ServiceConfig, options: { readonly logger?: Logger } = {}): Promise<RunningService> {
  const infrastructure = await createServiceInfrastructure('catalog-service-management', config, {
    workerDbRole: 'cat_worker',
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const { pool, publisher, logger, connection, lifecycle } = infrastructure;
  const directory = new RabbitUserDirectory(connection);
  lifecycle.onShutdown('user directory', () => directory.close());
  await infrastructure.startConsumers(
    catalogHandlers({ service: 'catalog-service-management', pool, publisher, logger, systemDbRole: 'cat_system' }),
  );
  return serveHttp(infrastructure, catalogRoutes(pool, directory), config.port);
}
