/**
 * Agents in chat, as the thread and the composer see them: what a task
 * handed to an agent looks like while it runs and once it has answered,
 * and the agents a person can ask. Pure and shared with the browser —
 * the server side (reading runs, starting them) is agent-asks.ts.
 *
 * The idea, in the person's words: an agent is a colleague who knows an
 * area. In a chat you message it with a task (@-mention it, or let the
 * chat suggest it), it works in the background with its own tools and
 * guardrails — on its owner's accounts, approvals and all — and its
 * answer comes back into the chat, under the request.
 */

import { isRecord } from '@renkei/guards';

export const CHAT_ASK_AGENT_TOOL = 'chat_ask_agent';

/** An agent the person may ask from a chat. */
export interface AskableAgent {
  id: string;
  name: string;
  description: string | null;
  /** Someone else's agent shared with the person: whose it is, in words. Null for their own. */
  ownerName: string | null;
  /** On the chat's project team (chat_project_agents). */
  onTeam: boolean;
}

/** One agent on a project's team, as its page lists it. */
export interface ProjectTeamMember {
  agentId: string;
  name: string;
  description: string | null;
  /** Whose agent it is, in words. */
  ownerName: string;
  /** Whether this viewer may ask it (their own, or shared with them). */
  canAsk: boolean;
}

/** Where a task handed to an agent stands, as the card says it. */
export type AskPhase =
  | 'queued'
  | 'working'
  /** Parked for a person: an approval, a question, or the owner's sign-in. */
  | 'waiting'
  | 'replied'
  /** The agent found nothing to do, and said why. */
  | 'nothing'
  | 'failed'
  | 'stopped';

export interface AgentAskView {
  runId: string;
  agentId: string;
  agentName: string;
  phase: AskPhase;
  /** One line under the agent's name: what it is doing or why it waits. */
  status: string;
  /** What the agent answered, once it has (markdown). */
  reply: string | null;
  /** The run's page, for whoever may open it (its owner and grantees). */
  runPath: string;
  askedAt: string;
  finishedAt: string | null;
}

/** Whether the card should keep asking: the run can still move on its own. */
export function askIsLive(phase: AskPhase): boolean {
  return phase === 'queued' || phase === 'working' || phase === 'waiting';
}

/** A run's status and error kind, as the card's phase and its line. */
export function askPhaseOf(
  status: string,
  errorKind: string | null,
  agentName: string
): { phase: AskPhase; status: string } {
  switch (status) {
    case 'queued':
      return { phase: 'queued', status: `Waiting for ${agentName} to pick this up` };
    case 'running':
      return { phase: 'working', status: `${agentName} is working on it` };
    case 'waiting':
      return errorKind === 'needs-sign-in'
        ? {
            phase: 'waiting',
            status: `Paused until ${agentName}’s owner signs in again`,
          }
        : {
            phase: 'waiting',
            status: `Waiting for a person to approve or answer ${agentName}`,
          };
    case 'succeeded':
      return { phase: 'replied', status: `${agentName} replied` };
    case 'stopped':
      return { phase: 'nothing', status: `${agentName} found nothing to do` };
    case 'canceled':
      return { phase: 'stopped', status: 'Stopped before it finished' };
    case 'failed':
      return { phase: 'failed', status: `${agentName} could not finish this` };
    default:
      return { phase: 'working', status: `${agentName} is working on it` };
  }
}

/**
 * What the agent answered, from its run's turns (oldest first): the
 * finishing turn's `result` — the reply the opening asked it to write —
 * else its finish summary. Null while no turn has finished the run.
 */
export function replyOfAttempts(attempts: readonly { detail?: unknown }[]): string | null {
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const detail = attempts[index].detail;
    if (!isRecord(detail) || typeof detail.finish !== 'string') continue;
    const result = typeof detail.result === 'string' ? detail.result.trim() : '';
    if (result) return result;
    const summary = typeof detail.llmSummary === 'string' ? detail.llmSummary.trim() : '';
    return summary || null;
  }
  return null;
}

/**
 * The agents in the order a picker offers them: the project's team first,
 * in the order they joined it, then the person's own, then those shared
 * with them, each by name. `query` narrows by name or description,
 * ignoring case.
 */
export function orderAskable(agents: readonly AskableAgent[], query = ''): AskableAgent[] {
  const needle = query.trim().toLowerCase();
  const matches = needle
    ? agents.filter(
        (agent) =>
          agent.name.toLowerCase().includes(needle) ||
          (agent.description ?? '').toLowerCase().includes(needle)
      )
    : [...agents];
  const rank = (agent: AskableAgent) => (agent.onTeam ? 0 : agent.ownerName === null ? 1 : 2);
  return matches
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => {
      const byRank = rank(a.agent) - rank(b.agent);
      if (byRank !== 0) return byRank;
      // The team keeps the order it was put together in.
      if (a.agent.onTeam) return a.index - b.index;
      return a.agent.name.localeCompare(b.agent.name) || a.index - b.index;
    })
    .map(({ agent }) => agent);
}
