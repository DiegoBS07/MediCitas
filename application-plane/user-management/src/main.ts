import { runService } from '@medicitas/runtime';
import { startUserManagement } from './service.js';

await runService('user-management', (config) => startUserManagement(config));
