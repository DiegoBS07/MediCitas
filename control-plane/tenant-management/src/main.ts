import { runService } from '@medicitas/runtime';
import { startTenantManagement } from './service.js';

await runService('tenant-management', (config) => startTenantManagement(config));
