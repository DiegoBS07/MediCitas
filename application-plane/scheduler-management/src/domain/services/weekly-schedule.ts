import { ConflictError, ValidationError } from '@medicitas/kernel';

/** One working block of a weekday, in the tenant's local time (RF5). dayOfWeek: ISO 1 = Monday … 7 = Sunday. */
export interface WeeklyBlock {
  readonly dayOfWeek: number;
  readonly startTime: string;
  readonly endTime: string;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutes(time: string): number {
  const match = TIME.exec(time);
  if (match === null) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Validates and normalizes a weekly schedule: valid weekdays, HH:mm on the 5-minute grid,
 * start < end, and no overlap between blocks of the same weekday (SCHEDULE_OVERLAP). The database
 * exclusion constraint weekly_schedule_blocks_no_overlap re-checks the last rule.
 */
export function normalizeWeeklySchedule(blocks: readonly WeeklyBlock[]): readonly WeeklyBlock[] {
  blocks.forEach((block, index) => {
    const start = minutes(block.startTime);
    const end = minutes(block.endTime);
    const path = `body.blocks.${index}`;
    if (!Number.isInteger(block.dayOfWeek) || block.dayOfWeek < 1 || block.dayOfWeek > 7) {
      throw new ValidationError('Invalid weekday.', [{ path: `${path}.dayOfWeek`, message: 'must be 1 (Monday) to 7 (Sunday)' }]);
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start % 5 !== 0 || end % 5 !== 0) {
      throw new ValidationError('Invalid block time.', [{ path, message: 'times must be HH:mm on the 5-minute grid' }]);
    }
    if (start >= end) throw new ValidationError('Invalid block.', [{ path, message: 'startTime must be before endTime' }]);
  });
  const sorted = [...blocks].sort((a, b) => a.dayOfWeek - b.dayOfWeek || minutes(a.startTime) - minutes(b.startTime));
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1] as WeeklyBlock;
    const current = sorted[index] as WeeklyBlock;
    if (previous.dayOfWeek === current.dayOfWeek && minutes(current.startTime) < minutes(previous.endTime)) {
      throw new ConflictError('SCHEDULE_OVERLAP', `Two blocks of weekday ${current.dayOfWeek} overlap.`);
    }
  }
  return sorted;
}
