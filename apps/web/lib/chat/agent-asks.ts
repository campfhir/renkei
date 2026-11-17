/**
 * Agents in chat, server side: a chat hands one of the person's agents a
 * task, the way the person would message a colleague who knows the area,
 * and reads back what it answered.
 *
 * - The task becomes an ordinary agent run (trigger kind 'chat'): the
 *   agent works with its own tools, guardrails and approvals, on its
 *   owner's accounts, exactly as it would from Run now — a chat gives it
 *   no tool it does not already have. The run's opening tells it the
 *   task came from a person in a chat and that its finish_run `result`
 *   is its reply (CHAT_STARTED_TEXT in @renkei/agents/run-prompts).
 * - Who may ask an agent is who may press its Run now: its owner, or
 *   someone it is shared with. A run a grantee starts reads as external
 *   to the act-approval policy, so the owner still accepts what it does.
 * - The ask is kept beside the chat (chat_agent_asks), tied to the
 *   `chat_ask_agent` call that made it: the thread draws the agent's
 *   reply under that call, the chat's next turns read it
 *   (agentAsksBrief), and the run's end notifies whoever asked
 *   (worker-agents' chat-ask-notification.ts).
 * - A chat project names a team (chat_project_agents): its chats offer
 *   those agents first. Anyone may still ask any agent they could run.
 */

import { getDataStore, type ChatAgentAskRecord } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { agentDefinitionOf } from '@renkei/agents';
import { createAgentRun } from '@renkei/agents/runs';
import { listAgents } from '@/lib/agents/store';
import { listAgentsSharedWith, resolveAgentAccess } from '@/lib/agents/access-grants';
import { getRunForOwner } from '@/lib/agents/runs-view';
import { getIdentityDisplay } from '@/lib/identity';
import { logger } from '@/lib/logger';
import { whichAgent, whoIs, whichAgentOf } from '@/lib/log-actor';
import { isUuid } from '@/lib/uuid';
import {
  CHAT_ASK_AGENT_TOOL,
  askPhaseOf,
  orderAskable,
  replyOfAttempts,
  type AgentAskView,
  type AskableAgent,
  type ProjectTeamMember,
} from './agent-ask-view';

/** How much of a task the agent is handed; the rest is the chat's to summarize. */
export const ASK_TASK_MAX_CHARS = 8_000;
/** How much of what the agent said before in this chat rides along with a new ask. */
const EARLIER_MAX_CHARS = 6_000;
/** How many earlier exchanges with the same agent a new ask carries. */
const EARLIER_ASKS = 3;

/** The agents this person may ask from a chat (in `projectId`, its team first). */
export async function listAskableAgents(
  subject: string,
  projectId: string | null
): Promise<AskableAgent[]> {
  const [own, shared, team] = await Promise.all([
    listAgents(subject),
    listAgentsSharedWith(subject),
    projectId ? getDataStore().chatAgents.listProjectAgents(projectId) : Promise.resolve([]),
  ]);
  const teamOrder = new Map(team.map((member, index) => [member.agentId, index]));
  const askable: AskableAgent[] = [
    ...own
      .filter((agent) => agent.enabled)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        ownerName: null,
        onTeam: teamOrder.has(agent.id),
      })),
    ...shared
      .filter((listing) => listing.agent.enabled)
      .map((listing) => ({
        id: listing.agent.id,
        name: listing.agent.name,
        description: listing.agent.description,
        ownerName: listing.ownerName ?? listing.ownerEmail ?? 'someone else',
        onTeam: teamOrder.has(listing.agent.id),
      })),
  ];
  // The team in the order it was put together; orderAskable keeps it.
  askable.sort((a, b) => (teamOrder.get(a.id) ?? 0) - (teamOrder.get(b.id) ?? 0));
  return orderAskable(askable);
}

export type AskAgentOutcome =
  | { ok: true; runId: string; agentName: string }
  | { ok: false; message: string };

/**
 * Hand an agent a task from a chat: start its run and keep the ask.
 * `message` is what the model (or the person) wrote for the agent; the
 * refusal messages are written for the chat's model to relay.
 */
export async function askAgent(input: {
  subject: string;
  chat: { id: string; title: string | null };
  toolUseId: string;
  agentId: string;
  message: string;
}): Promise<AskAgentOutcome> {
  const message = input.message.trim();
  if (!message) return { ok: false, message: 'Say what you want the agent to do.' };
  if (message.length > ASK_TASK_MAX_CHARS) {
    return {
      ok: false,
      message: `That task is ${message.length.toLocaleString()} characters; keep it under ${ASK_TASK_MAX_CHARS.toLocaleString()} — summarize, and leave out what the agent can look up itself.`,
    };
  }
  const access = isUuid(input.agentId)
    ? await resolveAgentAccess(input.subject, input.agentId)
    : null;
  if (!access) {
    return {
      ok: false,
      message:
        'No agent with that id is available to this person. Use an id from the agents listed in your instructions.',
    };
  }
  if (!access.agent.enabled) {
    return {
      ok: false,
      message: `${access.agent.name} is turned off, so it cannot be asked. Its owner can turn it on from its page.`,
    };
  }
  const store = getDataStore();
  const agent = await store.agents.find(input.agentId);
  if (!agent) return { ok: false, message: 'That agent no longer exists.' };

  const [person, earlier] = await Promise.all([
    getIdentityDisplay(input.subject),
    earlierExchanges(input.chat.id, input.agentId, access.ownerSubject),
  ]);
  const from = person?.displayName
    ? `${person.displayName}${person.email ? ` (${person.email})` : ''}`
    : (person?.email ?? input.subject);
  const result = await createAgentRun(
    agentJobsQueue().producer,
    {
      agentId: agent.id,
      ownerSubject: agent.ownerSubject,
      definition: agentDefinitionOf(agent),
      llmModelId: agent.llmModelId,
      triggerId: null,
      triggerKind: 'chat',
      triggeredBySubject: input.subject,
      initialState: {
        message,
        from,
        ...(input.chat.title ? { chat: input.chat.title } : {}),
        ...(earlier ? { earlier } : {}),
      },
    },
    { log: (line, meta) => logger.debug(line, meta) }
  );
  if (!result.ok) {
    if (result.err.type === 'DB_ERROR' || result.err.type === 'QUEUE_ERROR') {
      logger.error(
        '{actor} asked agent "{agent}" of {owner} for something from a chat, but no run was queued: {error}',
        {
          component: 'chat/agent-asks',
          ...(await whoIs(input.subject)),
          ...(await whichAgentOf({
            agentId: agent.id,
            agentName: agent.name,
            ownerSubject: agent.ownerSubject,
          })),
          chatId: input.chat.id,
          error: result.err.message ?? result.err.type,
        }
      );
    }
    return {
      ok: false,
      message: result.err.message ?? `${agent.name} could not be started just now.`,
    };
  }
  await store.chatAgents.recordAsk({
    runId: result.val.runId,
    chatId: input.chat.id,
    toolUseId: input.toolUseId,
    agentId: agent.id,
    askedBy: input.subject,
  });
  logger.info('{actor} asked agent "{agent}" of {owner} for something from the chat "{chat}"', {
    component: 'chat/agent-asks',
    ...(await whoIs(input.subject)),
    ...(await whichAgentOf({
      agentId: agent.id,
      agentName: agent.name,
      ownerSubject: agent.ownerSubject,
    })),
    chatId: input.chat.id,
    chat: input.chat.title || 'New chat',
    runId: result.val.runId,
  });
  return { ok: true, runId: result.val.runId, agentName: agent.name };
}

/** One ask, read: the run's state and, once it has one, the agent's reply. */
export async function readAsk(ask: ChatAgentAskRecord): Promise<AgentAskView | null> {
  const found = await getDataStore().agents.find(ask.agentId);
  if (!found) return null;
  const run = await getRunForOwner(found.ownerSubject, ask.agentId, ask.runId);
  if (!run) return null;
  const { phase, status } = askPhaseOf(run.status, run.errorKind, found.name);
  return {
    runId: ask.runId,
    agentId: ask.agentId,
    agentName: found.name,
    phase,
    status,
    reply: replyOfAttempts(run.attempts),
    runPath: `/agents/${ask.agentId}/runs/${ask.runId}`,
    askedAt: ask.createdAt.toISOString(),
    finishedAt: run.finishedAt,
  };
}

/** The ask a call in this chat's thread made, read; null when there is none. */
export async function readAskByCall(
  chatId: string,
  toolUseId: string
): Promise<AgentAskView | null> {
  const ask = await getDataStore().chatAgents.findAskByCall(chatId, toolUseId);
  return ask ? readAsk(ask) : null;
}

/** What `agentId` was asked and answered earlier in this chat, oldest first, for a new ask. */
async function earlierExchanges(
  chatId: string,
  agentId: string,
  ownerSubject: string
): Promise<string | null> {
  const asks = (await getDataStore().chatAgents.listAsks(chatId))
    .filter((ask) => ask.agentId === agentId)
    .slice(-EARLIER_ASKS);
  const parts: string[] = [];
  for (const ask of asks) {
    const run = await getRunForOwner(ownerSubject, agentId, ask.runId);
    if (!run) continue;
    const state = run.initialState;
    const asked =
      typeof state === 'object' && state !== null && !Array.isArray(state) && 'message' in state
        ? String(state.message)
        : null;
    const reply = replyOfAttempts(run.attempts);
    if (!asked && !reply) continue;
    parts.push(
      `They asked: ${asked ?? '(not recorded)'}\nYou replied: ${reply ?? `(no reply — the run ${run.status})`}`
    );
  }
  if (parts.length === 0) return null;
  const text = parts.join('\n\n');
  return text.length > EARLIER_MAX_CHARS ? `…${text.slice(-EARLIER_MAX_CHARS)}` : text;
}

/** How many of a chat's asks the system prompt reports on. */
const BRIEF_ASKS = 6;
/** How much of one reply the system prompt carries. */
const BRIEF_REPLY_CHARS = 4_000;
/** How many askable agents the system prompt lists. */
const BRIEF_AGENTS = 15;

/**
 * The system prompt's section on agents (request-builder.ts): whom the
 * chat may ask, and what the agents it already asked said — so "now
 * draft the email from that" works the turn after an agent answered.
 * Null when the person has no agent to ask and the chat asked none.
 * `addressedAgentId` is the agent the message was addressed to, when the
 * person may ask it — null otherwise, so nothing is allowed unasked.
 */
export async function agentAsksBrief(input: {
  subject: string;
  chatId: string;
  projectId: string | null;
  addressedAgentId: string | null;
}): Promise<{ brief: string; addressedAgentId: string | null } | null> {
  const [agents, asks] = await Promise.all([
    listAskableAgents(input.subject, input.projectId),
    getDataStore().chatAgents.listAsks(input.chatId),
  ]);
  const views = (await Promise.all(asks.slice(-BRIEF_ASKS).map(readAsk))).flatMap((view) =>
    view ? [view] : []
  );
  if (agents.length === 0 && views.length === 0) return null;
  const sections: string[] = [
    `Agents: the person has agents — colleagues who each know an area, work in the background with their own tools and approvals, and answer when done. Hand one a task with ${CHAT_ASK_AGENT_TOOL} when the person asks you to, or when a task clearly belongs to one (suggest it first unless they asked). ` +
      'The agent sees nothing of this chat but what you write: give it the whole task — the goal, the specifics (ids, names, dates), and what a good answer contains. After asking, tell the person in a sentence that the agent is on it; its reply appears in the chat when it finishes, so do not wait for it, poll, or invent its answer.',
  ];
  if (agents.length > 0) {
    const listed = agents.slice(0, BRIEF_AGENTS).map((agent) => {
      const tags = [
        agent.onTeam ? 'on this project’s team' : null,
        agent.ownerName ? `shared by ${agent.ownerName}` : null,
      ].filter(Boolean);
      return `- ${agent.name} (id ${agent.id})${tags.length ? ` — ${tags.join(', ')}` : ''}${agent.description ? `: ${agent.description}` : ''}`;
    });
    sections.push(`Agents you may ask:\n${listed.join('\n')}`);
  }
  const addressed = input.addressedAgentId
    ? agents.find((agent) => agent.id === input.addressedAgentId)
    : null;
  if (addressed) {
    sections.push(
      `The person addressed their latest message to ${addressed.name} (id ${addressed.id}). Call ${CHAT_ASK_AGENT_TOOL} with that agent now, passing their request as the task — in their words, with whatever from this chat the agent needs to act on it — then confirm in one short sentence. Do not do the task yourself.`
    );
  }
  if (views.length > 0) {
    const lines = views.map((view) => {
      const reply = view.reply
        ? `\n  Reply: ${view.reply.length > BRIEF_REPLY_CHARS ? `${view.reply.slice(0, BRIEF_REPLY_CHARS)}…` : view.reply}`
        : '';
      return `- ${view.agentName}, asked ${view.askedAt.slice(0, 16).replace('T', ' ')} UTC: ${view.status}.${reply}`;
    });
    sections.push(
      `Agents asked in this chat (oldest first; a reply is the agent’s, written to the person, and already shown to them in the chat):\n${lines.join('\n')}`
    );
  }
  return { brief: sections.join('\n\n'), addressedAgentId: addressed?.id ?? null };
}

/** A project's team, in the order it was put together, as `subject` sees it. */
export async function listProjectTeam(
  subject: string,
  projectId: string
): Promise<ProjectTeamMember[]> {
  const store = getDataStore();
  const members = await store.chatAgents.listProjectAgents(projectId);
  const team: ProjectTeamMember[] = [];
  for (const member of members) {
    const agent = await store.agents.find(member.agentId);
    if (!agent) continue;
    const [owner, access] = await Promise.all([
      getIdentityDisplay(agent.ownerSubject),
      resolveAgentAccess(subject, agent.id),
    ]);
    team.push({
      agentId: agent.id,
      name: agent.name,
      description: agent.description,
      ownerName:
        agent.ownerSubject === subject
          ? 'You'
          : (owner?.displayName ?? owner?.email ?? 'someone else'),
      canAsk: access !== null && agent.enabled,
    });
  }
  return team;
}

export type TeamChange = { ok: true } | { ok: false; status: 404 | 409; message: string };

/** Put an agent the person may ask on the project's team. */
export async function addToProjectTeam(
  subject: string,
  projectId: string,
  agentId: string
): Promise<TeamChange> {
  const access = isUuid(agentId) ? await resolveAgentAccess(subject, agentId) : null;
  if (!access) return { ok: false, status: 404, message: 'No such agent' };
  const added = await getDataStore().chatAgents.addProjectAgent(projectId, agentId, subject);
  if (!added) {
    return { ok: false, status: 409, message: `${access.agent.name} is already on this team.` };
  }
  logger.info('{actor} put agent "{agent}" of {owner} on a project\'s team', {
    component: 'chat/agent-asks',
    ...(await whoIs(subject)),
    ...(await whichAgentOf({
      agentId,
      agentName: access.agent.name,
      ownerSubject: access.ownerSubject,
    })),
    projectId,
  });
  return { ok: true };
}

/** Take an agent off the project's team (any editor may, whoever's agent it is). */
export async function removeFromProjectTeam(
  subject: string,
  projectId: string,
  agentId: string
): Promise<TeamChange> {
  if (!isUuid(agentId)) return { ok: false, status: 404, message: 'Not on this team' };
  const removed = await getDataStore().chatAgents.removeProjectAgent(projectId, agentId);
  if (!removed) return { ok: false, status: 404, message: 'Not on this team' };
  logger.info('{actor} took agent "{agent}" of {owner} off a project\'s team', {
    component: 'chat/agent-asks',
    ...(await whoIs(subject)),
    ...(await whichAgent(agentId)),
    projectId,
  });
  return { ok: true };
}
