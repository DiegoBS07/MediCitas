import { runService } from '@medicitas/runtime';
import { startCatalogService } from './service.js';

await runService('catalog-service-management', (config) => startCatalogService(config));
