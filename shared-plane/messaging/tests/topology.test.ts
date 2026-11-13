import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_TIERS_MS,
  EXCHANGES,
  SERVICES,
  exchangeDefinitions,
  permissionsFor,
  queueDeclarationsFor,
  retryExchangeOf,
  serviceOfBrokerUser,
} from '../src/index.js';

const exchangeNames = new Set(exchangeDefinitions().map((exchange) => exchange.name));

describe('RabbitMQ topology', () => {
  it('declares the four functional exchanges, the dead-letter exchange and one retry exchange per service', () => {
    for (const name of Object.values(EXCHANGES)) expect(exchangeNames.has(name)).toBe(true);
    for (const service of SERVICES) expect(exchangeNames.has(retryExchangeOf(service.service))).toBe(true);
    expect(exchangeNames.size).toBe(5 + SERVICES.length);
  });

  it('expands every consumer queue into main quorum queue + retry tiers + DLQ', () => {
    for (const service of SERVICES) {
      for (const queue of service.consumes) {
        const declarations = queueDeclarationsFor(queue, retryExchangeOf(service.service));
        expect(declarations).toHaveLength(2 + DEFAULT_RETRY_TIERS_MS.length);
        for (const declaration of declarations) expect(declaration.arguments['x-queue-type']).toBe('quorum');
        const [main, ...rest] = declarations;
        expect(main?.arguments['x-dead-letter-exchange']).toBe(EXCHANGES.deadLetter);
        const tiers = rest.slice(0, DEFAULT_RETRY_TIERS_MS.length);
        tiers.forEach((tier, index) => {
          expect(tier.name).toBe(`${queue.name}.retry.${index + 1}`);
          expect(tier.arguments['x-message-ttl']).toBe(DEFAULT_RETRY_TIERS_MS[index]);
          expect(tier.arguments['x-dead-letter-routing-key']).toBe(queue.name);
          expect(tier.bindings[0]?.exchange).toBe(retryExchangeOf(service.service));
        });
        expect(rest.at(-1)?.name).toBe(`${queue.name}.dlq`);
      }
    }
  });

  it('only binds queues to declared exchanges and names queues with the owning service prefix', () => {
    for (const service of SERVICES) {
      for (const queue of service.consumes) {
        expect(queue.name.startsWith(`${service.service}.`)).toBe(true);
        for (const binding of queue.bindings) expect(exchangeNames.has(binding.exchange)).toBe(true);
      }
    }
  });

  it('grants least privilege: no configure, write only own exchanges, read only own queues', () => {
    const scheduler = SERVICES.find((s) => s.service === 'scheduler-management');
    const orchestrator = SERVICES.find((s) => s.service === 'appointment-orchestrator');
    if (scheduler === undefined || orchestrator === undefined) throw new Error('missing service');
    const p = permissionsFor(scheduler);
    const write = new RegExp(p.write);
    const read = new RegExp(p.read);
    expect(p.configure).toBe('^$');
    expect(write.test('medicitas.domain-events')).toBe(true);
    expect(write.test('medicitas.replies')).toBe(true);
    expect(write.test('medicitas.retry.scheduler-management')).toBe(true);
    expect(write.test('medicitas.commands')).toBe(false);
    expect(write.test('medicitas.retry.appointment-orchestrator')).toBe(false);
    expect(write.test('medicitas.domain-eventsX')).toBe(false);
    expect(read.test('scheduler-management.commands')).toBe(true);
    expect(read.test('user-management.commands')).toBe(false);
    expect(new RegExp(permissionsFor(orchestrator).write).test('medicitas.commands')).toBe(true);
  });

  it('maps every broker user back to exactly one service', () => {
    for (const service of SERVICES) expect(serviceOfBrokerUser(service.brokerUser)).toBe(service.service);
    expect(serviceOfBrokerUser('guest')).toBeUndefined();
    expect(new Set(SERVICES.map((s) => s.brokerUser)).size).toBe(SERVICES.length);
  });
});
