/**
 * The agents/run.reply handler — the bot speaking an agent's outcome into
 * the WebEx thread that triggered it. The agents worker composes the
 * message (owner's `reply` variable or a plain outcome line) and this side
 * only delivers it, because the org bot credential lives with the
 * interactive worker's WebEx context.
 *
 * Delivery is best-effort: the run record is the durable outcome, the
 * thread reply is courtesy. A throw here would re-post on every queue
 * retry, so failures log and complete.
 */

import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { resolveWebexContext } from './webex-context';
import { logger } from '../logger';

interface ReplyPayload {
  roomId: string;
  parentId: string;
  markdown: string;
}

function parsePayload(event: ClaimedEvent): ReplyPayload | null {
  const payload: unknown = event.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record: { roomId?: unknown; parentId?: unknown; markdown?: unknown } = payload;
  if (typeof record.roomId !== 'string' || typeof record.markdown !== 'string') return null;
  return {
    roomId: record.roomId,
    parentId: typeof record.parentId === 'string' ? record.parentId : '',
    markdown: record.markdown,
  };
}

export function createAgentRunReplyHandler(): EventHandler {
  return async (event) => {
    const payload = parsePayload(event);
    if (!payload) {
      logger.warn('run.reply event with malformed payload; dropping', {
        component: 'worker/agent-reply',
      });
      return;
    }

    try {
      const context = await resolveWebexContext(event.tenant_id);
      const posted = await context.client.postMessage({
        roomId: payload.roomId,
        ...(payload.parentId ? { parentId: payload.parentId } : {}),
        markdown: payload.markdown,
      });
      if (!posted.ok) {
        logger.warn('agent thread reply not delivered to room {roomId}', {
          component: 'worker/agent-reply',
          tenantId: event.tenant_id,
          roomId: payload.roomId,
        });
      }
    } catch (error) {
      logger.warn('agent thread reply errored: {error}', {
        component: 'worker/agent-reply',
        tenantId: event.tenant_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
