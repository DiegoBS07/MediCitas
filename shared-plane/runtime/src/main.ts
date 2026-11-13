import { parseConfig } from '@medicitas/kernel';
import { serviceConfigFromEnv, serviceEnvSchema, type ServiceConfig } from './config.js';
import type { RunningService } from './lifecycle.js';

/** Entry point helper: parse the environment (fail fast), start, stop gracefully on SIGTERM/SIGINT. */
export async function runService(applicationName: string, start: (config: ServiceConfig) => Promise<RunningService>): Promise<void> {
  const config = serviceConfigFromEnv(parseConfig(serviceEnvSchema), applicationName);
  const service = await start(config);
  const stop = (signal: string): void => {
    service.logger.info({ signal }, 'shutting down');
    void service.stop().then(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
