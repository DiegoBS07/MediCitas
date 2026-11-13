import amqp from 'amqplib';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { EXCHANGES } from '@medicitas/messaging';
import { amqpUrl } from '../support/broker.js';
import { env } from '../support/env.js';
import { GATEWAY, api, availability, book, eventually, expectStatus, localDate, type ApiResult, type Appointment } from './support/api.js';
import { activeAppointments } from './support/evidence.js';
import { createPatient, createProfessional, tokenOf, type TestProfessional } from './support/fixture.js';
import { compose, startContainers, stopContainers } from './support/stack.js';

/**
 * Dependency failure and restart against the real containers (prompt §14 "caída/reinicio de
 * dependencias cuando sea viable"). Every test restores what it stops in a finally block.
 *
 *  - A saga participant down during a booking: the command waits in its durable quorum queue; a
 *    timeout is NOT a failure (202 + operation) and the booking completes when the participant returns.
 *  - A participant down beyond the saga deadline: explicit compensation, the slot is free again, and
 *    the late reply cannot resurrect the booking.
 *  - RabbitMQ restart: local transactions keep working (outbox), events are delivered after the
 *    broker returns, and the services reconnect their consumers by themselves.
 *  - Keycloak down: the gateway keeps validating tokens with its cached JWKS; readiness reports it.
 */
const fixture = inject('acceptance');

let professional: TestProfessional;
let token: string;

interface Operation {
  readonly data: { readonly status: string; readonly result: Appointment | null; readonly error: { readonly code: string } | null };
}

/** Resolves a booking answer to its terminal state, polling the operation resource after a 202. */
async function settle(result: ApiResult<{ data: Appointment }>, timeoutMs = 60_000): Promise<{ status: string; appointment: Appointment | null; error: string | null }> {
  if (result.status === 201) return { status: 'completed', appointment: result.body.data, error: null };
  expect(result.status).toBe(202);
  const location = String(result.headers.get('location'));
  expect(location).toMatch(/^\/api\/v1\/appointment-operations\//);
  return eventually(async () => {
    const operation = await api<Operation>('GET', location, { token });
    if (operation.status !== 200 || operation.body.data.status === 'running') return undefined;
    return { status: operation.body.data.status, appointment: operation.body.data.result, error: operation.body.data.error?.code ?? null };
  }, timeoutMs, 500, 'operation terminal');
}

const slotsOn = async (date: string): Promise<readonly string[]> =>
  expectStatus(await availability(token, professional.professionalId, fixture.serviceId, date), 200).body.data.slots.map((slot) => slot.startAt);

beforeAll(async () => {
  token = await tokenOf(fixture.receptionists[0]);
  professional = await createProfessional(fixture, { name: 'Dra. Resiliente' });
});

describe('a saga participant goes down (RF9 never treats a timeout as a failure)', () => {
  it('completes the booking once catalog-service-management comes back within the saga deadline', { timeout: 180_000 }, async () => {
    const date = localDate(fixture.timezone, 13);
    const startAt = String((await slotsOn(date))[0]);
    const patientId = await createPatient(token, 'Resiliencia');
    await stopContainers(['catalog-service-management']);
    let answer: ApiResult<{ data: Appointment }>;
    try {
      const pending = book(token, { patientId, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      // Start the container alone (no dependency re-runs, no health wait): it consumes the queued command as soon as it is up.
      await compose(['up', '-d', '--no-deps', 'catalog-service-management']);
      answer = await pending;
    } finally {
      await startContainers(['catalog-service-management']);
    }
    const outcome = await settle(answer);
    expect(outcome).toMatchObject({ status: 'completed', error: null });
    expect(outcome.appointment).toMatchObject({ status: 'booked', startAt });
    expect((await activeAppointments(fixture.tenantId, professional.professionalId)).filter((row) => row.starts_at.toISOString() === startAt)).toHaveLength(1);
  });

  it('compensates when the participant stays down past the deadline: nothing booked, slot free, late reply ignored', { timeout: 180_000 }, async () => {
    const date = localDate(fixture.timezone, 14);
    const startAt = String((await slotsOn(date))[0]);
    const patientId = await createPatient(token, 'Resiliencia');
    await stopContainers(['catalog-service-management']);
    try {
      const answer = await book(token, { patientId, professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt });
      expect(answer.status).toBe(202); // still running after the 8 s synchronous wait
      const outcome = await settle(answer, 90_000);
      expect(outcome.status).toBe('failed');
      expect(outcome.appointment).toBeNull();
      expect(['DEPENDENCY_UNAVAILABLE', 'BOOKING_INTERRUPTED']).toContain(outcome.error);
      expect(await slotsOn(date)).toContain(startAt); // the held slot was released (explicit compensation)
    } finally {
      await startContainers(['catalog-service-management']);
    }
    // The participant now processes the stale command; its late reply must not book anything.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(await slotsOn(date)).toContain(startAt);
    expect((await activeAppointments(fixture.tenantId, professional.professionalId)).filter((row) => row.starts_at.toISOString() === startAt)).toEqual([]);
  });
});

describe('RabbitMQ restart', () => {
  it('keeps local writes working through the outbox, delivers their events afterwards and the services reconnect', { timeout: 300_000 }, async () => {
    const date = localDate(fixture.timezone, 15);
    const startAt = String((await slotsOn(date))[0]);
    const booked = expectStatus(await book(token, { patientId: await createPatient(token, 'Broker'), professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt }), 201)
      .body.data;

    // A durable observer queue survives the broker restart (exclusive taps would not).
    const queue = `test.outbox.${randomUUID().slice(0, 8)}`;
    const url = amqpUrl(env('RABBITMQ_ADMIN_USER'), env('RABBITMQ_ADMIN_PASSWORD'));
    let connection = await amqp.connect(url);
    let channel = await connection.createChannel();
    await channel.assertQueue(queue, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
    await channel.bindQueue(queue, EXCHANGES.events, 'scheduler.appointment.cancelled');
    await connection.close();

    await stopContainers(['rabbitmq']);
    try {
      // Local ACID transaction in the scheduler: succeeds without the broker; the event waits in the outbox.
      const cancelled = expectStatus(await api<{ data: Appointment }>('POST', `/api/v1/appointments/${booked.appointmentId}/cancel`, { token, body: { reason: 'broker down' } }), 200);
      expect(cancelled.body.data.status).toBe('cancelled');
      expect(await slotsOn(date)).toContain(startAt); // I7 does not depend on the broker
    } finally {
      await startContainers(['rabbitmq']);
    }

    connection = await amqp.connect(url);
    channel = await connection.createChannel();
    try {
      const delivered = await eventually(async () => {
        const message = await channel.get(queue, { noAck: true });
        if (message === false) return undefined;
        const envelope = JSON.parse(message.content.toString('utf8')) as { payload: { appointmentId?: string } };
        return envelope.payload.appointmentId === booked.appointmentId ? envelope : undefined;
      }, 90_000, 1_000, 'AppointmentCancelled delivered by the outbox relay');
      expect(delivered.payload.appointmentId).toBe(booked.appointmentId);
    } finally {
      await channel.deleteQueue(queue);
      await connection.close();
    }

    // Consumers reconnected by themselves: a full saga over the broker works again.
    const again = await eventually(async () => {
      const result = await book(token, { patientId: await createPatient(token, 'Broker'), professionalId: professional.professionalId, serviceId: fixture.serviceId, startAt });
      return result.status === 201 ? result : undefined;
    }, 90_000, 3_000, 'booking after the broker restart');
    expect(again.body.data.status).toBe('booked');
  });
});

describe('Keycloak outage', () => {
  it('the gateway keeps validating already issued tokens with its cached keys and reports degraded readiness', { timeout: 300_000 }, async () => {
    const admin = await tokenOf(fixture.admin);
    expect((await api('GET', '/api/v1/me', { token: admin })).status).toBe(200); // keys cached
    await stopContainers(['keycloak']);
    try {
      expect((await api('GET', '/api/v1/me', { token: admin })).status).toBe(200);
      expect((await api('GET', '/api/v1/patients?limit=1', { token })).status).toBe(200);
      expect((await fetch(`${GATEWAY}/health/ready`)).status).toBe(503);
      expect((await fetch(`${GATEWAY}/health/live`)).status).toBe(200);
    } finally {
      await startContainers(['keycloak']);
    }
    await eventually(async () => ((await fetch(`${GATEWAY}/health/ready`)).status === 200 ? true : undefined), 60_000, 1_000, 'gateway ready again');
  });
});
