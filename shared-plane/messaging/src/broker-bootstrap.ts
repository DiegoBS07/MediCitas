import {
  SERVICES,
  exchangeDefinitions,
  permissionsFor,
  queueDeclarationsFor,
  retryExchangeOf,
  type BrokerPermissions,
  type ExchangeDefinition,
  type QueueDeclaration,
} from './topology.js';

export interface ManagementApiConfig {
  readonly baseUrl: string;
  readonly adminUser: string;
  readonly adminPassword: string;
  readonly vhost: string;
}

export interface BootstrapSummary {
  readonly exchanges: number;
  readonly queues: number;
  readonly bindings: number;
  readonly users: number;
}

/**
 * Minimal client of the RabbitMQ management HTTP API. Every operation is an idempotent PUT
 * (or a binding POST, which is a no-op when the binding already exists).
 */
export class ManagementApi {
  private readonly authorization: string;

  constructor(private readonly config: ManagementApiConfig) {
    this.authorization = `Basic ${Buffer.from(`${config.adminUser}:${config.adminPassword}`).toString('base64')}`;
  }

  get vhost(): string {
    return this.config.vhost;
  }

  get adminUser(): string {
    return this.config.adminUser;
  }

  async request(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.config.baseUrl}/api${path}`, {
      method,
      headers: { authorization: this.authorization, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      // The body may echo request data; only the status and path are reported.
      throw new Error(`RabbitMQ management API ${method} ${path} failed with HTTP ${response.status}`);
    }
    const text = await response.text();
    return text === '' ? null : (JSON.parse(text) as unknown);
  }

  async waitUntilReady(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        await this.request('GET', '/overview');
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  private v(): string {
    return encodeURIComponent(this.config.vhost);
  }

  async ensureVhost(): Promise<void> {
    await this.request('PUT', `/vhosts/${this.v()}`, {
      description: 'MediCitas logical broker',
      default_queue_type: 'quorum',
    });
  }

  async ensureUser(name: string, password: string): Promise<void> {
    await this.request('PUT', `/users/${encodeURIComponent(name)}`, { password, tags: '' });
  }

  async setPermissions(user: string, permissions: BrokerPermissions): Promise<void> {
    await this.request('PUT', `/permissions/${this.v()}/${encodeURIComponent(user)}`, permissions);
  }

  async ensureExchange(exchange: ExchangeDefinition): Promise<void> {
    await this.request('PUT', `/exchanges/${this.v()}/${encodeURIComponent(exchange.name)}`, {
      type: exchange.type,
      durable: true,
      auto_delete: false,
      internal: false,
      arguments: {},
    });
  }

  async ensureQueue(queue: QueueDeclaration): Promise<number> {
    await this.request('PUT', `/queues/${this.v()}/${encodeURIComponent(queue.name)}`, {
      durable: true,
      auto_delete: false,
      arguments: queue.arguments,
    });
    for (const binding of queue.bindings) {
      await this.request(
        'POST',
        `/bindings/${this.v()}/e/${encodeURIComponent(binding.exchange)}/q/${encodeURIComponent(queue.name)}`,
        { routing_key: binding.routingKey, arguments: {} },
      );
    }
    return queue.bindings.length;
  }

  async deleteQueue(name: string): Promise<void> {
    await this.request('DELETE', `/queues/${this.v()}/${encodeURIComponent(name)}`);
  }

  async deleteExchange(name: string): Promise<void> {
    await this.request('DELETE', `/exchanges/${this.v()}/${encodeURIComponent(name)}`);
  }

  /**
   * Operational inspection (e.g. a DLQ): fetches and REMOVES up to `count` messages.
   * Returns the AMQP properties (headers include x-dead-letter-reason) and the payload text.
   */
  async takeMessages(
    queue: string,
    count: number,
  ): Promise<readonly { readonly properties: Readonly<Record<string, unknown>>; readonly payload: string }[]> {
    const result = await this.request('POST', `/queues/${this.v()}/${encodeURIComponent(queue)}/get`, {
      count,
      ackmode: 'ack_requeue_false',
      encoding: 'auto',
    });
    return Array.isArray(result)
      ? result.map((item: { properties?: Record<string, unknown>; payload?: string }) => ({
          properties: item.properties ?? {},
          payload: item.payload ?? '',
        }))
      : [];
  }

  async getQueue(name: string): Promise<{ readonly type?: string; readonly messages?: number; readonly arguments?: Record<string, unknown> }> {
    return (await this.request('GET', `/queues/${this.v()}/${encodeURIComponent(name)}`)) as {
      type?: string;
      messages?: number;
      arguments?: Record<string, unknown>;
    };
  }
}

/**
 * Applies the complete MediCitas topology: vhost, admin permissions, per-service users with
 * least-privilege permissions, exchanges (including per-service retry exchanges), every consumer
 * queue with its retry tiers and DLQ, and all bindings. Safe to run on every start.
 */
export async function applyTopology(
  api: ManagementApi,
  servicePasswords: Readonly<Record<string, string>>,
): Promise<BootstrapSummary> {
  await api.ensureVhost();
  // The administrative user keeps full rights on the vhost for operations; services never use it.
  await api.setPermissions(api.adminUser, { configure: '.*', write: '.*', read: '.*' });

  const exchanges = exchangeDefinitions();
  for (const exchange of exchanges) await api.ensureExchange(exchange);

  let queues = 0;
  let bindings = 0;
  for (const service of SERVICES) {
    const password = servicePasswords[service.passwordEnv];
    if (password === undefined || password === '') throw new Error(`Missing broker password: ${service.passwordEnv}`);
    await api.ensureUser(service.brokerUser, password);
    await api.setPermissions(service.brokerUser, permissionsFor(service));
    for (const queue of service.consumes) {
      for (const declaration of queueDeclarationsFor(queue, retryExchangeOf(service.service))) {
        bindings += await api.ensureQueue(declaration);
        queues += 1;
      }
    }
  }
  return { exchanges: exchanges.length, queues, bindings, users: SERVICES.length };
}
