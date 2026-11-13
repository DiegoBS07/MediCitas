import type { SagaRecord, SagaStepRecord } from '@medicitas/runtime';

export const CLINIC_ROLES = ['clinic_admin', 'receptionist', 'health_professional'] as const;
export type ClinicRole = (typeof CLINIC_ROLES)[number];

export const SAGA_TYPES = { creation: 'user-creation', roleChange: 'user-role-change', deactivation: 'user-deactivation' } as const;

/** Command steps (RabbitMQ to user-management) and local steps (Keycloak Admin REST). */
export const COMMANDS = {
  reserve_user: { messageType: 'ReserveUserCommand', routingKey: 'user-management.user.reserve' },
  activate_user: { messageType: 'ActivateUserCommand', routingKey: 'user-management.user.activate' },
  cancel_reservation: { messageType: 'CancelUserReservationCommand', routingKey: 'user-management.user.cancel-reservation' },
  change_role: { messageType: 'ChangeUserRoleCommand', routingKey: 'user-management.user.change-role' },
  deactivate_user: { messageType: 'DeactivateUserCommand', routingKey: 'user-management.user.deactivate' },
} as const;
export type CommandStep = keyof typeof COMMANDS;
export const LOCAL_STEPS = ['keycloak_user', 'delete_keycloak_user', 'keycloak_role', 'keycloak_disable'] as const;
export type LocalStep = (typeof LOCAL_STEPS)[number];

export interface CreationRequest {
  readonly userId: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly role: ClinicRole;
}

export type Next =
  | { readonly kind: 'wait' }
  | { readonly kind: 'command'; readonly step: CommandStep; readonly payload: Readonly<Record<string, unknown>>; readonly status: string }
  | { readonly kind: 'local'; readonly step: LocalStep; readonly status: string }
  | { readonly kind: 'compensate'; readonly errorCode: string }
  | { readonly kind: 'complete'; readonly result: Readonly<Record<string, unknown>> }
  | { readonly kind: 'fail'; readonly errorCode: string };

const done = (step: SagaStepRecord | undefined): boolean => step !== undefined && (step.status === 'succeeded' || step.status === 'rejected' || step.status === 'failed');
const bad = (step: SagaStepRecord | undefined): boolean => step?.status === 'rejected' || step?.status === 'failed';

/**
 * RF2 decisions:
 *  creation   — reserve (DB) → Keycloak user → activate (DB); compensation = delete the Keycloak user
 *               created by THIS saga + cancel the reservation; the row is kept as provisioning_failed.
 *  role/deactivation — the DB command runs FIRST (it enforces LAST_CLINIC_ADMIN under a lock); then
 *               Keycloak converges with retries and is never rolled back.
 */
export function nextStep(saga: SagaRecord, steps: readonly SagaStepRecord[]): Next {
  const step = (name: string): SagaStepRecord | undefined => steps.find((candidate) => candidate.name === name);
  const errorOf = (name: string): string => step(name)?.errorCode ?? 'DEPENDENCY_UNAVAILABLE';
  const request = saga.request as unknown as CreationRequest & { readonly targetUserId?: string; readonly role?: ClinicRole };

  if (saga.status === 'compensating') {
    const cancel = step('cancel_reservation');
    const removal = step('delete_keycloak_user');
    // An identity created by an in-flight call AFTER the deletion ran is deleted again (bounded).
    const lateIdentity = step('keycloak_user')?.status === 'succeeded' && removal?.status === 'succeeded' && removal.result?.['deleted'] === false;
    if (lateIdentity && (removal?.attempts ?? 0) < 5) return { kind: 'local', step: 'delete_keycloak_user', status: 'compensating' };
    return done(cancel) && (removal === undefined || done(removal)) ? { kind: 'fail', errorCode: saga.errorCode ?? 'DEPENDENCY_UNAVAILABLE' } : { kind: 'wait' };
  }

  switch (saga.sagaType) {
    case SAGA_TYPES.creation: {
      const reserve = step('reserve_user');
      const identity = step('keycloak_user');
      const activation = step('activate_user');
      if (saga.status === 'started') {
        if (bad(reserve)) return { kind: 'fail', errorCode: errorOf('reserve_user') };
        return reserve?.status === 'succeeded' ? { kind: 'local', step: 'keycloak_user', status: 'reserved' } : { kind: 'wait' };
      }
      if (saga.status === 'reserved') {
        if (bad(identity)) return { kind: 'compensate', errorCode: errorOf('keycloak_user') };
        if (identity?.status !== 'succeeded') return { kind: 'wait' };
        return {
          kind: 'command',
          step: 'activate_user',
          status: 'activating',
          payload: { userId: request.userId, keycloakSubject: identity.result?.['keycloakSubject'] },
        };
      }
      if (saga.status === 'activating') {
        if (bad(activation)) return { kind: 'compensate', errorCode: errorOf('activate_user') };
        return activation?.status === 'succeeded' && activation.result !== null ? { kind: 'complete', result: activation.result } : { kind: 'wait' };
      }
      return { kind: 'wait' };
    }
    case SAGA_TYPES.roleChange:
    case SAGA_TYPES.deactivation: {
      const command = step(saga.sagaType === SAGA_TYPES.roleChange ? 'change_role' : 'deactivate_user');
      const local: LocalStep = saga.sagaType === SAGA_TYPES.roleChange ? 'keycloak_role' : 'keycloak_disable';
      if (saga.status === 'started') {
        if (bad(command)) return { kind: 'fail', errorCode: command?.errorCode ?? 'DEPENDENCY_UNAVAILABLE' };
        return command?.status === 'succeeded' ? { kind: 'local', step: local, status: 'activating' } : { kind: 'wait' };
      }
      if (saga.status === 'activating' && step(local)?.status === 'succeeded' && command?.result !== null && command?.result !== undefined) {
        return { kind: 'complete', result: command.result };
      }
      return { kind: 'wait' };
    }
    default:
      return { kind: 'wait' };
  }
}

/** HTTP status of a terminal failure. */
export function httpStatusOf(code: string): number {
  switch (code) {
    case 'EMAIL_TAKEN':
    case 'LAST_CLINIC_ADMIN':
    case 'INVALID_STATE_TRANSITION':
      return 409;
    case 'RESOURCE_NOT_FOUND':
      return 404;
    default:
      return 503;
  }
}
