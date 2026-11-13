import { z } from 'zod';
import type { DatabaseConfig } from '@medicitas/kernel';
import type { JwtVerifierConfig } from '@medicitas/identity';

/**
 * Environment variables shared by every service container. Each container receives generic names
 * (DB_PASSWORD, RABBITMQ_PASSWORD, …); docker-compose maps them from the per-service .env entries.
 */
export const serviceEnvSchema = z.object({
  SERVICE_PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  RABBITMQ_HOST: z.string().min(1),
  RABBITMQ_PORT: z.coerce.number().int().min(1).max(65_535).default(5672),
  RABBITMQ_VHOST: z.string().min(1),
  RABBITMQ_PASSWORD: z.string().min(1),
  KEYCLOAK_JWKS_URL: z.url(),
  KEYCLOAK_PUBLIC_ISSUER: z.url(),
  KEYCLOAK_AUDIENCE: z.string().min(1).default('medicitas-api'),
});
export type ServiceEnv = z.infer<typeof serviceEnvSchema>;

export interface BrokerSettings {
  readonly host: string;
  readonly port: number;
  readonly vhost: string;
  readonly password: string;
}

/** Process-independent configuration of a service (tests build it directly from .env). */
export interface ServiceConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly database: DatabaseConfig;
  readonly broker: BrokerSettings;
  readonly identity: JwtVerifierConfig;
}

export function serviceConfigFromEnv(env: ServiceEnv, applicationName: string): ServiceConfig {
  return {
    port: env.SERVICE_PORT,
    logLevel: env.LOG_LEVEL,
    database: {
      host: env.DB_HOST,
      port: env.DB_PORT,
      database: env.DB_NAME,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      applicationName,
      maxConnections: env.DB_POOL_MAX,
    },
    broker: { host: env.RABBITMQ_HOST, port: env.RABBITMQ_PORT, vhost: env.RABBITMQ_VHOST, password: env.RABBITMQ_PASSWORD },
    identity: { jwksUrl: env.KEYCLOAK_JWKS_URL, issuer: env.KEYCLOAK_PUBLIC_ISSUER, audience: env.KEYCLOAK_AUDIENCE },
  };
}
