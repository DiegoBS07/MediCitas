import { AsyncLocalStorage } from 'node:async_hooks';

/** Correlation metadata attached to every log line produced while handling a request or message. */
export interface LogContext {
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly messageId?: string;
  readonly sagaId?: string;
  readonly tenantId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(context: LogContext, work: () => T): T {
  const parent = storage.getStore() ?? {};
  return storage.run({ ...parent, ...context }, work);
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}
