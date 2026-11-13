import { onboardingConfigFromEnv, startOnboarding } from './service.js';

const service = await startOnboarding(onboardingConfigFromEnv());
const stop = (signal: string): void => {
  service.logger.info({ signal }, 'shutting down');
  void service.stop().then(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
