import { describe, expect, it } from 'vitest';
import { assertBooked, isPublic, toAppointmentView, type Appointment } from '../../src/domain/entities/appointment.js';
import { normalizeWeeklySchedule } from '../../src/domain/services/weekly-schedule.js';
import { datesBetween, daysBetween, futureSlots } from '../../src/application/queries/availability.js';
import { availabilityKey } from '../../src/infrastructure/cache/availability-cache.js';

const appointment: Appointment = {
  id: 'a',
  tenantId: 't',
  patientId: 'p',
  professionalId: 'pr',
  serviceId: 's',
  startAt: new Date('2026-12-01T14:00:00Z'),
  endAt: new Date('2026-12-01T14:30:00Z'),
  durationMinutes: 30,
  timezone: 'America/Costa_Rica',
  status: 'booked',
  holdExpiresAt: null,
  sagaId: null,
  rescheduledFromId: null,
  rescheduledToId: null,
  bookedBySubject: 'u',
  cancelReason: null,
  cancelledBySubject: null,
  cancelledAt: null,
  outcomeRecordedBySubject: null,
  outcomeRecordedAt: null,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('weekly schedule rules (RF5)', () => {
  it('sorts blocks and accepts several non-overlapping blocks per day (split shift)', () => {
    const blocks = normalizeWeeklySchedule([
      { dayOfWeek: 1, startTime: '13:00', endTime: '17:00' },
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 2, startTime: '08:00', endTime: '12:00' },
    ]);
    expect(blocks.map((block) => `${block.dayOfWeek} ${block.startTime}`)).toEqual(['1 08:00', '1 13:00', '2 08:00']);
  });

  it('rejects overlaps, inverted blocks, off-grid times and invalid weekdays', () => {
    expect(() =>
      normalizeWeeklySchedule([
        { dayOfWeek: 3, startTime: '08:00', endTime: '12:00' },
        { dayOfWeek: 3, startTime: '11:55', endTime: '13:00' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'SCHEDULE_OVERLAP' }));
    expect(() => normalizeWeeklySchedule([{ dayOfWeek: 1, startTime: '12:00', endTime: '08:00' }])).toThrowError();
    expect(() => normalizeWeeklySchedule([{ dayOfWeek: 1, startTime: '08:03', endTime: '12:00' }])).toThrowError();
    expect(() => normalizeWeeklySchedule([{ dayOfWeek: 8, startTime: '08:00', endTime: '12:00' }])).toThrowError();
    // Back-to-back blocks do not overlap ([start, end) semantics).
    expect(normalizeWeeklySchedule([{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }, { dayOfWeek: 1, startTime: '12:00', endTime: '13:00' }])).toHaveLength(2);
  });
});

describe('appointment state machine (RF13)', () => {
  it('allows transitions only from booked and hides internal states', () => {
    expect(() => assertBooked(appointment, 'cancel')).not.toThrow();
    for (const status of ['attended', 'no_show', 'cancelled', 'rescheduled', 'held', 'released'] as const) {
      expect(() => assertBooked({ ...appointment, status }, 'cancel')).toThrowError(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
    }
    expect(isPublic({ ...appointment, status: 'held' })).toBe(false);
    expect(isPublic({ ...appointment, status: 'released' })).toBe(false);
    expect(toAppointmentView(appointment)).toMatchObject({ startAt: '2026-12-01T14:00:00.000Z', cancellation: null, outcome: null });
  });
});

describe('availability helpers (RF7/RF8, ADR-0008)', () => {
  it('builds versioned, tenant-scoped cache keys', () => {
    expect(availabilityKey({ tenantId: 't1', professionalId: 'p', serviceId: 's', date: '2026-12-01', version: '4.12.2' })).toBe(
      'availability:v1:tenant:t1:professional:p:service:s:date:2026-12-01:version:4.12.2',
    );
  });

  it('filters past slots after the cache and enumerates date ranges', () => {
    const result = {
      cache: 'HIT' as const,
      now: new Date('2026-12-01T14:10:00Z'),
      entry: {
        tenantId: 't',
        professionalId: 'p',
        serviceId: 's',
        date: '2026-12-01',
        timezone: 'UTC',
        durationMinutes: 30,
        stepMinutes: 15,
        version: '1.1.1',
        generatedAt: '',
        slots: [
          { startAt: '2026-12-01T14:00:00.000Z', endAt: '2026-12-01T14:30:00.000Z', localStartTime: '08:00' },
          { startAt: '2026-12-01T14:15:00.000Z', endAt: '2026-12-01T14:45:00.000Z', localStartTime: '08:15' },
        ],
      },
    };
    expect(futureSlots(result).map((slot) => slot.localStartTime)).toEqual(['08:15']);
    expect(datesBetween('2026-12-30', '2027-01-02')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
    expect(daysBetween('2026-12-01', '2026-12-14')).toBe(14);
  });
});
