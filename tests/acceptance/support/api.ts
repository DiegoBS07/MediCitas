import { randomUUID } from 'node:crypto';

/** The API gateway published by Compose: the ONLY entry point acceptance tests use for the API. */
export const GATEWAY = `http://127.0.0.1:${process.env['GATEWAY_HOST_PORT'] ?? '8000'}`;

export interface ApiResult<T = Record<string, unknown>> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
  readonly correlationId: string;
}

export interface CallOptions {
  readonly token?: string;
  readonly body?: unknown;
  /** Raw body (sent as-is) for malformed-input tests. */
  readonly rawBody?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** true → a fresh random key; a string → that key. */
  readonly idempotencyKey?: string | true;
  readonly correlationId?: string;
}

/** One HTTP call through the gateway. Never logs tokens or bodies. */
export async function api<T = Record<string, unknown>>(method: string, path: string, options: CallOptions = {}): Promise<ApiResult<T>> {
  const correlationId = options.correlationId ?? randomUUID();
  const headers: Record<string, string> = { 'X-Correlation-Id': correlationId, ...options.headers };
  if (options.token !== undefined) headers['Authorization'] = `Bearer ${options.token}`;
  if (options.idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = options.idempotencyKey === true ? `acc-${randomUUID()}` : options.idempotencyKey;
  }
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined && headers['Content-Type'] === undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${GATEWAY}${path}`, { method, headers, body, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let parsed: unknown = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed as T, headers: response.headers, correlationId };
}

/** Error code of a problem+json body (or undefined). */
export function codeOf(result: ApiResult<unknown>): string | undefined {
  const body = result.body;
  if (body !== null && typeof body === 'object' && 'code' in body && typeof body.code === 'string') return body.code;
  return undefined;
}

/** Asserts the status and returns the result, with the error code in the message when it differs. */
export function expectStatus<T>(result: ApiResult<T>, status: number, label = ''): ApiResult<T> {
  if (result.status !== status) {
    const code = codeOf(result as ApiResult<unknown>);
    throw new Error(`${label === '' ? '' : `${label}: `}expected HTTP ${status}, got ${result.status}${code === undefined ? '' : ` ${code}`}`);
  }
  return result;
}

/** Retries `probe` until it returns a non-undefined value (eventual consistency of replicas/events). */
export async function eventually<T>(probe: () => Promise<T | undefined>, timeoutMs = 20_000, intervalMs = 250, label = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const reason = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`${label} not met within ${timeoutMs} ms${reason}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Local calendar date (YYYY-MM-DD) of now + days in a timezone. */
export function localDate(timezone: string, days = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(Date.now() + days * 86_400_000));
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a local date. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export interface Slot {
  readonly startAt: string;
  readonly endAt: string;
  readonly localStartTime: string;
}

export interface Availability {
  readonly data: { readonly date: string; readonly version: string; readonly durationMinutes: number; readonly slots: readonly Slot[] };
}

export interface Appointment {
  readonly appointmentId: string;
  readonly patientId: string;
  readonly professionalId: string;
  readonly serviceId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly durationMinutes: number;
  readonly status: string;
  readonly rescheduledFromId: string | null;
  readonly rescheduledToId: string | null;
  readonly cancellation: { readonly reason: string; readonly cancelledBy: string; readonly cancelledAt: string } | null;
  readonly outcome: { readonly recordedBy: string; readonly recordedAt: string } | null;
}

export async function availability(token: string, professionalId: string, serviceId: string, date: string): Promise<ApiResult<Availability>> {
  return api<Availability>('GET', `/api/v1/availability?professionalId=${professionalId}&serviceId=${serviceId}&date=${date}`, { token });
}

export async function book(
  token: string,
  input: { readonly patientId: string; readonly professionalId: string; readonly serviceId: string; readonly startAt: string },
  idempotencyKey: string | true = true,
): Promise<ApiResult<{ data: Appointment }>> {
  return api<{ data: Appointment }>('POST', '/api/v1/appointments', {
    token,
    idempotencyKey,
    body: { patient: { id: input.patientId }, professionalId: input.professionalId, serviceId: input.serviceId, startAt: input.startAt },
  });
}
