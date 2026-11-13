/** Booking saga (ADR-0006 §4): STARTED → AWAITING_PARTICIPANTS → CONFIRMING → COMPLETED, or → COMPENSATING → FAILED. */
export const SAGA_STATUSES = ['started', 'awaiting_participants', 'confirming', 'completed', 'compensating', 'failed'] as const;
export type SagaStatus = (typeof SAGA_STATUSES)[number];

export const STEP_NAMES = ['patient', 'catalog', 'slot', 'confirm', 'release'] as const;
export type StepName = (typeof STEP_NAMES)[number];

export type StepStatus = 'pending' | 'dispatched' | 'succeeded' | 'rejected' | 'failed' | 'compensating' | 'compensated' | 'skipped';

export type PatientRequest =
  | { readonly mode: 'existing'; readonly patientId: string }
  | {
      readonly mode: 'create';
      readonly patientId: string;
      readonly patient: Readonly<Record<string, unknown>>;
    };

export interface ReplyError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** Business reply as stored on the step (messaging-contracts §6). */
export interface StepReply {
  readonly outcome: 'succeeded' | 'rejected' | 'failed';
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly error: ReplyError | null;
}

export interface SagaStep {
  readonly name: StepName;
  readonly status: StepStatus;
  readonly commandMessageId: string | null;
  readonly reply: StepReply | null;
}

export interface BookingSaga {
  readonly id: string;
  readonly tenantId: string;
  readonly appointmentId: string;
  readonly patientId: string;
  readonly professionalId: string;
  readonly serviceId: string;
  readonly startAt: Date;
  readonly patientMode: 'existing' | 'create';
  readonly status: SagaStatus;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
  readonly errorDetail: string | null;
  readonly actorSubject: string;
  readonly actorRole: 'clinic_admin' | 'receptionist';
  readonly correlationId: string;
  readonly deadlineAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function isTerminal(status: SagaStatus): boolean {
  return status === 'completed' || status === 'failed';
}

export type Decision =
  | { readonly kind: 'wait' }
  | { readonly kind: 'confirm' }
  | { readonly kind: 'complete'; readonly appointment: Readonly<Record<string, unknown>> }
  | { readonly kind: 'compensate'; readonly errorCode: string | null }
  | { readonly kind: 'fail'; readonly errorCode: string | null };

const PARTICIPANTS: readonly StepName[] = ['patient', 'catalog', 'slot'];

function step(steps: readonly SagaStep[], name: StepName): SagaStep | undefined {
  return steps.find((candidate) => candidate.name === name);
}

const isBad = (candidate: SagaStep | undefined): boolean => candidate?.status === 'rejected' || candidate?.status === 'failed';

/**
 * Aggregation rules (ADR-0006 §4). Pure: given the saga and its steps, what happens next.
 * A compensation (ReleaseSlotCommand) is needed if and only if the slot step succeeded or its
 * outcome is still unknown; the release is idempotent and a no-op for a slot that was never held.
 */
export function decide(saga: BookingSaga, steps: readonly SagaStep[]): Decision {
  switch (saga.status) {
    case 'awaiting_participants': {
      const slot = step(steps, 'slot');
      if (PARTICIPANTS.some((name) => isBad(step(steps, name)))) {
        const slotMayBeHeld = slot?.status === 'succeeded' || slot?.status === 'dispatched';
        return slotMayBeHeld ? { kind: 'compensate', errorCode: null } : { kind: 'fail', errorCode: null };
      }
      if (!PARTICIPANTS.every((name) => step(steps, name)?.status === 'succeeded')) return { kind: 'wait' };
      const catalog = step(steps, 'catalog')?.reply?.result ?? {};
      const held = slot?.reply?.result ?? {};
      // D4 cross-check: the scheduler computed the interval from its replica; Catalog is authoritative.
      const coherent = catalog['durationMinutes'] === held['durationMinutes'] && catalog['serviceVersion'] === held['serviceVersion'];
      return coherent ? { kind: 'confirm' } : { kind: 'compensate', errorCode: 'CATALOG_REPLICA_STALE' };
    }
    case 'confirming': {
      const confirm = step(steps, 'confirm');
      if (confirm?.status === 'succeeded' && confirm.reply?.result !== null && confirm.reply?.result !== undefined) {
        return { kind: 'complete', appointment: confirm.reply.result };
      }
      if (isBad(confirm)) return { kind: 'compensate', errorCode: 'BOOKING_INTERRUPTED' };
      return { kind: 'wait' };
    }
    case 'compensating': {
      const release = step(steps, 'release');
      return release !== undefined && release.status !== 'dispatched' ? { kind: 'fail', errorCode: null } : { kind: 'wait' };
    }
    default:
      return { kind: 'wait' };
  }
}

/** Precedence of the final failure reason (ADR-0006 §4 rule 5): the most specific business error wins. */
const PRECEDENCE: readonly (readonly string[])[] = [
  ['SLOT_TAKEN'],
  ['PATIENT_OVERLAP'],
  [
    'PATIENT_IDENTIFICATION_TAKEN',
    'PROFESSIONAL_NOT_QUALIFIED',
    'OUTSIDE_WORKING_HOURS',
    'SLOT_BLOCKED',
    'SLOT_MISALIGNED',
    'SLOT_IN_PAST',
    'SERVICE_INACTIVE',
    'PROFESSIONAL_INACTIVE',
    'PATIENT_INACTIVE',
    'DATE_RANGE_TOO_LARGE',
  ],
  ['RESOURCE_NOT_FOUND'],
  ['CATALOG_REPLICA_STALE', 'BOOKING_INTERRUPTED'],
];

function rank(code: string): number {
  const index = PRECEDENCE.findIndex((group) => group.includes(code));
  if (index >= 0) return index;
  return code === 'DEPENDENCY_UNAVAILABLE' ? PRECEDENCE.length + 1 : PRECEDENCE.length;
}

export interface FailureReason {
  readonly code: string;
  readonly detail: string;
  readonly details: Readonly<Record<string, string>>;
}

/** Chooses the failure reason among the step errors and an explicit saga error (deadline, stale replica). */
export function failureReason(steps: readonly SagaStep[], explicit: string | null): FailureReason {
  const candidates: FailureReason[] = [];
  for (const candidate of steps) {
    const error = candidate.reply?.error;
    if (error === null || error === undefined || candidate.name === 'release') continue;
    const code = error.code === 'HOLD_EXPIRED' ? 'BOOKING_INTERRUPTED' : candidate.reply?.outcome === 'failed' ? 'DEPENDENCY_UNAVAILABLE' : error.code;
    const existing = candidate.reply?.result?.['existingPatientId'];
    candidates.push({ code, detail: error.message, details: typeof existing === 'string' ? { patientId: existing } : {} });
  }
  if (explicit !== null) candidates.push({ code: explicit, detail: defaultDetail(explicit), details: {} });
  if (candidates.length === 0) candidates.push({ code: 'DEPENDENCY_UNAVAILABLE', detail: defaultDetail('DEPENDENCY_UNAVAILABLE'), details: {} });
  return [...candidates].sort((a, b) => rank(a.code) - rank(b.code))[0] as FailureReason;
}

function defaultDetail(code: string): string {
  switch (code) {
    case 'CATALOG_REPLICA_STALE':
      return 'The scheduler catalog replica disagreed with Catalog; retry shortly.';
    case 'BOOKING_INTERRUPTED':
      return 'The slot hold expired before confirmation; nothing was booked. Retry with a new Idempotency-Key.';
    default:
      return 'A participant did not answer in time; nothing was booked.';
  }
}

/** HTTP status of a terminal failure (api-contracts §3.7). */
export function httpStatusOf(code: string): number {
  if (code === 'SLOT_TAKEN' || code === 'PATIENT_OVERLAP' || code === 'PATIENT_IDENTIFICATION_TAKEN') return 409;
  if (code === 'RESOURCE_NOT_FOUND') return 404;
  if (code === 'CATALOG_REPLICA_STALE' || code === 'BOOKING_INTERRUPTED' || code === 'DEPENDENCY_UNAVAILABLE') return 503;
  if ((PRECEDENCE[2] as readonly string[]).includes(code)) return 422;
  return 503;
}
