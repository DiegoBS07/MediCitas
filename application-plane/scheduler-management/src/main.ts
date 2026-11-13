import { startScheduler } from './service.js';
import { schedulerConfigFromEnv } from './config.js';

const service = await startScheduler(schedulerConfigFromEnv());
const stop = (signal: string): void => {
  service.logger.info({ signal }, 'shutting down');
  void service.stop().then(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
