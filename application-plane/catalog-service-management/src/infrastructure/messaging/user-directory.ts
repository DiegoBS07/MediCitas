import { z } from 'zod';
import { DependencyUnavailableError } from '@medicitas/kernel';
import { QueryClient, ReplyPayloadSchema, createEnvelope, type AmqpConnectionManager } from '@medicitas/messaging';
import type { DirectoryUser, UserDirectory } from '../../application/ports/catalog-ports.js';

const ResultSchema = z.object({
  found: z.boolean(),
  user: z
    .object({ userId: z.uuid(), keycloakSubject: z.uuid().nullable(), role: z.string(), status: z.string() })
    .nullable(),
});

/**
 * GetTenantUserQuery over RabbitMQ direct reply-to. A timeout is a 503,
 * never "not found" (the requester cannot tell a slow responder from a missing user).
 */
export class RabbitUserDirectory implements UserDirectory {
  private readonly client: QueryClient;

  constructor(connection: AmqpConnectionManager, timeoutMs = 3_000) {
    this.client = new QueryClient(connection, { brokerUser: 'svc_catalog', timeoutMs });
  }

  async getTenantUser(input: Parameters<UserDirectory['getTenantUser']>[0]): Promise<DirectoryUser | null> {
    const reply = await this.client.request(
      'user-management.user.get',
      createEnvelope({
        messageType: 'GetTenantUserQuery',
        producer: 'catalog-service-management',
        tenantId: input.tenantId,
        actor: { subject: input.actor.subject, roles: [...input.actor.roles] },
        correlationId: input.correlationId,
        payload: { userId: input.userId },
      }),
      ReplyPayloadSchema,
    );
    if (reply.outcome !== 'succeeded') throw new DependencyUnavailableError('user directory');
    const result = ResultSchema.safeParse(reply.result);
    if (!result.success) throw new DependencyUnavailableError('user directory (malformed reply)');
    return result.data.found && result.data.user !== null ? result.data.user : null;
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
