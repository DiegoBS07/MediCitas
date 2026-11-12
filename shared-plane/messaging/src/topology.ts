/**
 * Declarative RabbitMQ topology (ADR-0003, docs/contracts/messaging-contracts.md §2–§3).
 * Single source of truth for the broker bootstrap, the consumers and the contract tests.
 */

export const EXCHANGES = {
  commands: 'medicitas.commands',
  queries: 'medicitas.queries',
  replies: 'medicitas.replies',
  events: 'medicitas.domain-events',
  deadLetter: 'medicitas.dead-letter',
} as const;

export const SERVICE_NAMES = [
  'tenant-management',
  'onboarding-orchestrator',
  'user-management',
  'user-management-orchestrator',
  'catalog-service-management',
  'scheduler-management',
  'appointment-orchestrator',
] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

/** Default exchange alias used for direct reply-to answers. */
export const DEFAULT_EXCHANGE = '';
export const DIRECT_REPLY_TO = 'amq.rabbitmq.reply-to';

/** Exponential back-off tiers (ms) of the per-queue delayed retry queues. */
export const DEFAULT_RETRY_TIERS_MS: readonly number[] = [2_000, 10_000, 30_000];

export interface ExchangeDefinition {
  readonly name: string;
  readonly type: 'topic' | 'direct';
}

export interface BindingDefinition {
  readonly exchange: string;
  readonly routingKey: string;
}

export interface QueueDefinition {
  readonly name: string;
  readonly bindings: readonly BindingDefinition[];
  readonly prefetch: number;
  readonly retryTiersMs?: readonly number[];
}

export interface ServiceMessagingDefinition {
  readonly service: ServiceName;
  readonly brokerUser: string;
  /** Environment variable holding the broker password of this service. */
  readonly passwordEnv: string;
  readonly publishesTo: readonly string[];
  readonly consumes: readonly QueueDefinition[];
  /** requester: sends synchronous queries; responder: answers them through the default exchange. */
  readonly directReplyTo: 'requester' | 'responder' | 'none';
}

/** Per-service retry exchange: only that service may publish to it (prevents producer spoofing). */
export function retryExchangeOf(service: ServiceName): string {
  return `medicitas.retry.${service}`;
}

export function retryQueueName(queue: string, tier: number): string {
  return `${queue}.retry.${tier}`;
}

export function deadLetterQueueName(queue: string): string {
  return `${queue}.dlq`;
}

const commandsQueue = (service: ServiceName): QueueDefinition => ({
  name: `${service}.commands`,
  bindings: [{ exchange: EXCHANGES.commands, routingKey: `${service}.#` }],
  prefetch: 10,
});

const repliesQueue = (service: ServiceName): QueueDefinition => ({
  name: `${service}.replies`,
  bindings: [{ exchange: EXCHANGES.replies, routingKey: service }],
  prefetch: 20,
});

export const SERVICES: readonly ServiceMessagingDefinition[] = [
  {
    service: 'tenant-management',
    brokerUser: 'svc_tenant_management',
    passwordEnv: 'RABBITMQ_TM_PASSWORD',
    publishesTo: [EXCHANGES.replies, EXCHANGES.events],
    consumes: [commandsQueue('tenant-management')],
    directReplyTo: 'none',
  },
  {
    service: 'onboarding-orchestrator',
    brokerUser: 'svc_onboarding_orchestrator',
    passwordEnv: 'RABBITMQ_ONB_PASSWORD',
    publishesTo: [EXCHANGES.commands],
    consumes: [repliesQueue('onboarding-orchestrator')],
    directReplyTo: 'none',
  },
  {
    service: 'user-management',
    brokerUser: 'svc_user_management',
    passwordEnv: 'RABBITMQ_UM_PASSWORD',
    publishesTo: [EXCHANGES.replies, EXCHANGES.events],
    consumes: [
      commandsQueue('user-management'),
      {
        name: 'user-management.queries',
        bindings: [{ exchange: EXCHANGES.queries, routingKey: 'user-management.#' }],
        prefetch: 10,
      },
      {
        name: 'user-management.events.replicas',
        bindings: [{ exchange: EXCHANGES.events, routingKey: 'tenant.tenant.onboarded' }],
        prefetch: 10,
      },
    ],
    directReplyTo: 'responder',
  },
  {
    service: 'user-management-orchestrator',
    brokerUser: 'svc_user_management_orchestrator',
    passwordEnv: 'RABBITMQ_UMO_PASSWORD',
    publishesTo: [EXCHANGES.commands],
    consumes: [repliesQueue('user-management-orchestrator')],
    directReplyTo: 'none',
  },
  {
    service: 'catalog-service-management',
    brokerUser: 'svc_catalog',
    passwordEnv: 'RABBITMQ_CAT_PASSWORD',
    publishesTo: [EXCHANGES.replies, EXCHANGES.queries, EXCHANGES.events],
    consumes: [
      commandsQueue('catalog-service-management'),
      {
        name: 'catalog-service-management.events.replicas',
        bindings: [
          { exchange: EXCHANGES.events, routingKey: 'tenant.tenant.onboarded' },
          { exchange: EXCHANGES.events, routingKey: 'user.user.deactivated' },
        ],
        prefetch: 10,
      },
    ],
    directReplyTo: 'requester',
  },
  {
    service: 'scheduler-management',
    brokerUser: 'svc_scheduler',
    passwordEnv: 'RABBITMQ_SCH_PASSWORD',
    publishesTo: [EXCHANGES.replies, EXCHANGES.events],
    consumes: [
      commandsQueue('scheduler-management'),
      {
        name: 'scheduler-management.events.replicas',
        bindings: [
          { exchange: EXCHANGES.events, routingKey: 'tenant.tenant.onboarded' },
          { exchange: EXCHANGES.events, routingKey: 'catalog.service.*' },
          { exchange: EXCHANGES.events, routingKey: 'catalog.professional.*' },
        ],
        prefetch: 10,
      },
      {
        name: 'scheduler-management.events.audit',
        bindings: [{ exchange: EXCHANGES.events, routingKey: 'user.patient.contact-accessed' }],
        prefetch: 10,
      },
      {
        name: 'scheduler-management.events.cache-invalidation',
        bindings: [{ exchange: EXCHANGES.events, routingKey: 'scheduler.availability.changed' }],
        prefetch: 10,
      },
    ],
    directReplyTo: 'none',
  },
  {
    service: 'appointment-orchestrator',
    brokerUser: 'svc_appointment_orchestrator',
    passwordEnv: 'RABBITMQ_AO_PASSWORD',
    publishesTo: [EXCHANGES.commands],
    consumes: [repliesQueue('appointment-orchestrator')],
    directReplyTo: 'none',
  },
];

export function exchangeDefinitions(): readonly ExchangeDefinition[] {
  return [
    { name: EXCHANGES.commands, type: 'topic' },
    { name: EXCHANGES.queries, type: 'topic' },
    { name: EXCHANGES.replies, type: 'direct' },
    { name: EXCHANGES.events, type: 'topic' },
    { name: EXCHANGES.deadLetter, type: 'direct' },
    ...SERVICES.map((s): ExchangeDefinition => ({ name: retryExchangeOf(s.service), type: 'direct' })),
  ];
}

/** A queue with its broker arguments and bindings, ready for the management API. */
export interface QueueDeclaration {
  readonly name: string;
  readonly arguments: Readonly<Record<string, string | number>>;
  readonly bindings: readonly BindingDefinition[];
}

/**
 * Expands one consumer queue into: the main quorum queue (poison messages beyond the broker
 * delivery limit are dead-lettered), N delayed retry tiers that dead-letter back into the main
 * queue after their TTL, and the final DLQ.
 */
export function queueDeclarationsFor(queue: QueueDefinition, retryExchange: string): readonly QueueDeclaration[] {
  const tiers = queue.retryTiersMs ?? DEFAULT_RETRY_TIERS_MS;
  const main: QueueDeclaration = {
    name: queue.name,
    arguments: {
      'x-queue-type': 'quorum',
      'x-dead-letter-exchange': EXCHANGES.deadLetter,
      'x-dead-letter-routing-key': queue.name,
      'x-dead-letter-strategy': 'at-least-once',
      'x-overflow': 'reject-publish',
    },
    bindings: queue.bindings,
  };
  const retries = tiers.map(
    (ttl, index): QueueDeclaration => ({
      name: retryQueueName(queue.name, index + 1),
      arguments: {
        'x-queue-type': 'quorum',
        'x-message-ttl': ttl,
        'x-dead-letter-exchange': DEFAULT_EXCHANGE,
        'x-dead-letter-routing-key': queue.name,
        'x-dead-letter-strategy': 'at-least-once',
        'x-overflow': 'reject-publish',
      },
      bindings: [{ exchange: retryExchange, routingKey: retryQueueName(queue.name, index + 1) }],
    }),
  );
  const dlq: QueueDeclaration = {
    name: deadLetterQueueName(queue.name),
    arguments: { 'x-queue-type': 'quorum' },
    bindings: [{ exchange: EXCHANGES.deadLetter, routingKey: queue.name }],
  };
  return [main, ...retries, dlq];
}

export interface BrokerPermissions {
  readonly configure: string;
  readonly write: string;
  readonly read: string;
}

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Least privilege (ADR-0003): no configure; write only to the exchanges used; read only own queues. */
export function permissionsFor(definition: ServiceMessagingDefinition): BrokerPermissions {
  const writeTargets = [
    ...definition.publishesTo,
    retryExchangeOf(definition.service),
    EXCHANGES.deadLetter,
    ...(definition.directReplyTo === 'responder' ? ['amq.default'] : []),
  ];
  const readTargets = [
    `${escapeRegex(definition.service)}\\..*`,
    ...(definition.directReplyTo === 'requester' ? [escapeRegex(DIRECT_REPLY_TO)] : []),
  ];
  return {
    configure: '^$',
    write: `^(${writeTargets.map(escapeRegex).join('|')})$`,
    read: `^(${readTargets.join('|')})$`,
  };
}

export function serviceDefinition(service: ServiceName): ServiceMessagingDefinition {
  const definition = SERVICES.find((candidate) => candidate.service === service);
  if (definition === undefined) throw new Error(`Unknown service: ${service}`);
  return definition;
}

/** Maps the broker-validated AMQP user_id to the producing service. */
export function serviceOfBrokerUser(brokerUser: string | undefined): ServiceName | undefined {
  return SERVICES.find((candidate) => candidate.brokerUser === brokerUser)?.service;
}
