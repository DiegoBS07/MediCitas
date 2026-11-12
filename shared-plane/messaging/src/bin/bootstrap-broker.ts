/**
 * One-shot container entry point (rabbitmq-bootstrap): applies the declarative topology and exits.
 * Exit code 0 lets docker compose start the services (`service_completed_successfully`).
 */
import { z } from 'zod';
import { parseConfig } from '@medicitas/kernel';
import { createLogger } from '@medicitas/observability';
import { ManagementApi, applyTopology } from '../broker-bootstrap.js';
import { SERVICES } from '../topology.js';

const logger = createLogger({ service: 'rabbitmq-bootstrap' });

const ConfigSchema = z.object({
  RABBITMQ_MANAGEMENT_URL: z.url(),
  RABBITMQ_ADMIN_USER: z.string().min(1),
  RABBITMQ_ADMIN_PASSWORD: z.string().min(8),
  RABBITMQ_VHOST: z.string().min(1),
});

const PasswordsSchema = z.record(z.string(), z.string().min(8));

async function main(): Promise<void> {
  const config = parseConfig(ConfigSchema);
  const api = new ManagementApi({
    baseUrl: config.RABBITMQ_MANAGEMENT_URL,
    adminUser: config.RABBITMQ_ADMIN_USER,
    adminPassword: config.RABBITMQ_ADMIN_PASSWORD,
    vhost: config.RABBITMQ_VHOST,
  });
  logger.info('waiting for the RabbitMQ management API');
  await api.waitUntilReady();
  const passwords = parseConfig(
    PasswordsSchema,
    Object.fromEntries(SERVICES.map((service) => [service.passwordEnv, process.env[service.passwordEnv]])),
  );
  const summary = await applyTopology(api, passwords);
  logger.info(summary, 'RabbitMQ topology applied');
}

main().catch((error: unknown) => {
  logger.error({ err: error instanceof Error ? error.message : String(error) }, 'RabbitMQ bootstrap failed');
  process.exitCode = 1;
});
