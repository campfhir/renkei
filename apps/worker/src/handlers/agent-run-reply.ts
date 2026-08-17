/**
 * The agents/run.reply handler — an agent's outcome spoken into the WebEx
 * thread that triggered it, posted with the run OWNER's own token: there
 * is no bot, so the agent replies as the person it belongs to. The agents
 * worker composes the message; this side only delivers it.
 *
 * Delivery is best-effort: the run record is the durable outcome, the
 * thread reply is courtesy. A throw here would re-post on every queue
 * retry, so failures log and complete. An owner with no usable WebEx
 * grant simply gets no reply — their run history still has everything.
 */

import { WebexClient } from '@renkei/connector-webex';
import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { resolveWebexUserAccessBySubject } from './webex-linked-user';
import { logger } from '../logger';

interface ReplyPayload {
  roomId: string;
  parentId: string;
  markdown: string;
  ownerSubject: string;
}

function parsePayload(event: ClaimedEvent): ReplyPayload | null {
  const payload: unknown = event.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record: {
    roomId?: unknown;
    parentId?: unknown;
    markdown?: unknown;
    ownerSubject?: unknown;
  } = payload;
  if (typeof record.roomId !== 'string' || typeof record.markdown !== 'string') return null;
  if (typeof record.ownerSubject !== 'string' || !record.ownerSubject) return null;
  return {
    roomId: record.roomId,
    parentId: typeof record.parentId === 'string' ? record.parentId : '',
    markdown: record.markdown,
    ownerSubject: record.ownerSubject,
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
      const access = await resolveWebexUserAccessBySubject(event.tenant_id, payload.ownerSubject);
      if (!access) {
        logger.warn('run owner has no usable WebEx grant; reply not delivered', {
          component: 'worker/agent-reply',
          tenantId: event.tenant_id,
        });
        return;
      }
      const posted = await new WebexClient(access.accessToken).postMessage({
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
