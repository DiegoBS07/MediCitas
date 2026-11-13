import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { currentLogContext } from './context.js';

export type { Logger } from 'pino';

/**
 * Paths removed from every log line before serialization: credentials, tokens and personal
 * data (no secrets, tokens or sensitive data in logs).
 */
export const REDACTED_PATHS: readonly string[] = [
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  '*.password',
  'temporaryPassword',
  '*.temporaryPassword',
  '*.*.temporaryPassword',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'access_token',
  '*.access_token',
  'refreshToken',
  '*.refreshToken',
  'clientSecret',
  '*.clientSecret',
  'client_secret',
  '*.client_secret',
  'secret',
  '*.secret',
  'contact',
  '*.contact',
  'email',
  '*.email',
  'phone',
  '*.phone',
  'address',
  '*.address',
  'content',
  '*.content',
  'payload.patient',
  'payload.contact',
];

export interface LoggerConfig {
  readonly service: string;
  readonly level?: string;
}

export function createLogger(config: LoggerConfig, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level: config.level ?? 'info',
    base: { service: config.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'message',
    redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    // Correlation fields of the current request/message are added to every line.
    mixin: () => ({ ...currentLogContext() }),
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
