/**
 * The person who handed an agent a task from their chat
 * (apps/web/lib/chat/agent-asks.ts) hears when it answers: one row in
 * their notification feed and a push that opens the chat, where the
 * agent's reply is drawn under their request. Every ending counts — a
 * "nothing to do" or a failure is still the answer to what they asked —
 * except a run someone stopped, who already knows. The run's own owner
 * notifications are untouched: an owner asking their own agent from chat
 * hears this, not a second notice.
 */

import { randomUUID } from 'node:crypto';
import { actorAttrs, agentAttrs, getDataStore } from '@renkei/db';
import { loadKeyring } from '@renkei/crypto';
import { sendPush } from '@renkei/notifications';
import type { FinalizedRun } from './engine';
import { logger } from './logger';

/** What the headline says the agent did, by how the run ended. */
export function chatAskHeadline(agentName: string, chatTitle: string, status: string): string {
  const chat = `“${chatTitle}”`;
  switch (status) {
    case 'failed':
      return `${agentName} could not finish what you asked in ${chat}`;
    default:
      return `${agentName} replied in ${chat}`;
  }
}

/** True when a notice went out (or there was nobody to tell). */
export async function notifyChatAsker(run: FinalizedRun): Promise<boolean> {
  const store = getDataStore();
  const ask = await store.chatAgents.findAskByRun(run.runId);
  if (!ask || run.status === 'canceled') return true;
  const agent = await agentAttrs(run.agentId);
  try {
    const chat = await store.chats.get(ask.chatId);
    const agentName = typeof agent.agent === 'string' && agent.agent ? agent.agent : 'Your agent';
    const headline = chatAskHeadline(agentName, chat?.title || 'New chat', run.status);
    const refUrl = `/chat/${ask.chatId}`;
    const id = randomUUID();
    await store.notifications.insert({
      id,
      subject: ask.askedBy,
      // The chat reply's kind: the feed opens it in the chat, as a reply.
      kind: 'chat_reply',
      category: null,
      connector: null,
      tool: null,
      entity: null,
      headline,
      refUrl,
      agentId: run.agentId,
      agentName,
      runId: run.runId,
      meta: null,
      refId: run.runId,
    });
    const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
    if (keyResult.ok) {
      void sendPush(
        ask.askedBy,
        keyResult.val,
        {
          title: headline,
          body: agentName,
          tag: `chat-ask:${run.runId}`,
          refUrl,
          notificationId: id,
          appPath: refUrl,
          // The reply is drawn in that chat: no banner while it is on screen.
          quiet: true,
        },
        { log: (message, meta) => logger.warn(message, { ...agent, ...meta }) }
      );
    }
    return true;
  } catch (error) {
    logger.warn(
      'agent "{agent}" of {owner} answered what {actor} asked from a chat, but they were not notified: {error}',
      {
        component: 'worker-agents/chat-ask',
        ...agent,
        ...(await actorAttrs(ask.askedBy)),
        runId: run.runId,
        chatId: ask.chatId,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return false;
  }
}
