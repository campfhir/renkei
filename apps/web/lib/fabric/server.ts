/**
 * The Fabric page's server side: the signed-in person's Fabric access
 * (their own grant, through the delegate — the tools' resolver), and
 * moving one of their operations along while they watch it. Routes under
 * app/api/fabric/ call these; nothing here trusts an id the session does
 * not own.
 */

import { advanceIfDue } from '@renkei/connector-fabric';
import { getDataStore, type FabricOperationRecord } from '@renkei/db';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';
import { resolveFabricAccess, type FabricAccess } from '@/lib/mcp-tools/fabric/client';

export async function fabricAccessFor(subject: string): Promise<FabricAccess | string> {
  return resolveFabricAccess({ subject });
}

/**
 * The person's operation, moved along first when it is due and nobody
 * else holds it — what the stream calls each tick and the polling
 * fallback calls on each GET. Null when it is not theirs.
 */
export async function currentOperation(
  subject: string,
  id: string,
  access?: FabricAccess | string
): Promise<FabricOperationRecord | null> {
  const store = getDataStore().fabricOperations;
  const operation = await store.find(subject, id);
  if (!operation || operation.status !== 'running') return operation;
  const now = new Date();
  if (operation.nextPollAt && operation.nextPollAt.getTime() > now.getTime()) return operation;
  const fabric = access ?? (await fabricAccessFor(subject));
  if (typeof fabric === 'string') {
    // No grant any more (disconnected, revoked): the operation cannot end
    // any other way, so it ends here, saying why.
    const ended = await store.finish(id, { status: 'failed', result: null, error: fabric }, now);
    return ended ?? (await store.find(subject, id));
  }
  try {
    const advanced = await advanceIfDue(id, fabric.fetcher, fabric.base, now);
    return advanced?.operation ?? (await store.find(subject, id));
  } catch (error) {
    logger.warn(
      '{actor} was watching the Fabric definition of "{item}", but asking Fabric about it failed; it will be asked again: {error}',
      {
        component: 'fabric/operations',
        ...(await whoIs(subject)),
        operationId: id,
        item: operation.itemName,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return operation;
  }
}
