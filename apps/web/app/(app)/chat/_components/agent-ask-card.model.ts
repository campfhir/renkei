/**
 * A task the chat handed one of the person's agents (chat_ask_agent,
 * lib/chat/agent-asks.ts), as its card in the thread says it, with no
 * React: who it went to, where it stands — waiting for the person's OK,
 * handed over, queued, working, waiting on an approval, answered — the
 * task as the agent got it, and the agent's reply once it has one. While
 * the agent can still move on its own the card keeps asking; once it has
 * answered (or failed, or was stopped) it stops.
 *
 * agent-ask-card.tsx renders from this and makes the calls. Tested in
 * agent-ask-card.model.test.ts.
 */

import { askIsLive, type AgentAskView, type AskableAgent } from '@/lib/chat/agent-ask-view';

/** How the call itself stands in the thread (message-list.model.ts's MilestoneState). */
export type AskCallState = 'waiting' | 'pending' | 'done' | 'failed';

export interface AgentAskCardState {
  ask: AgentAskView | null;
  /** The ask could not be read, in words; the card keeps what it last had. */
  error: string | null;
  /** The server has no ask for this call (its run is gone). */
  missing: boolean;
}

export type AgentAskCardAction =
  | { type: 'loaded'; ask: AgentAskView }
  | { type: 'loadFailed'; message: string; notFound: boolean };

export const initialAgentAskCard: AgentAskCardState = { ask: null, error: null, missing: false };

export function agentAskCardReducer(
  state: AgentAskCardState,
  action: AgentAskCardAction
): AgentAskCardState {
  switch (action.type) {
    case 'loaded':
      return { ask: action.ask, error: null, missing: false };
    case 'loadFailed':
      return action.notFound
        ? { ...state, missing: true, error: null }
        : { ...state, error: action.message };
  }
}

/** Whether to ask the server (again): the call went through and the agent may still move. */
export function shouldPoll(call: AskCallState, state: AgentAskCardState): boolean {
  if (call !== 'done' || state.missing) return false;
  return state.ask === null || askIsLive(state.ask.phase);
}

export interface AgentAskCardView {
  /** The card's first line. */
  title: string;
  /** What it is doing, or why it stopped. */
  line: string;
  /** Spinner beside the line. */
  busy: boolean;
  tone: 'neutral' | 'waiting' | 'done' | 'failed';
  /** The task as the agent got it. */
  task: string;
  reply: string | null;
  /** The run's page, once there is a run. */
  runPath: string | null;
  /** "Reply to …": address the composer to this agent. */
  replyTo: AskableAgent | null;
}

/** The task the call handed over, from its input. */
export function taskOf(input: unknown): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return '';
  const record: { task?: unknown } = input;
  return typeof record.task === 'string' ? record.task.trim() : '';
}

export function agentAskCardView(
  call: { state: AskCallState; input: unknown; result: { content: string; isError?: boolean } | null },
  state: AgentAskCardState
): AgentAskCardView {
  const task = taskOf(call.input);
  const base = { task, reply: null, runPath: null, replyTo: null };
  if (call.state === 'waiting') {
    return {
      ...base,
      title: 'Ask an agent?',
      line: 'Waiting for your OK to hand this to an agent',
      busy: false,
      tone: 'waiting',
    };
  }
  if (call.state === 'pending') {
    return { ...base, title: 'Asking an agent', line: 'Handing the task over…', busy: true, tone: 'neutral' };
  }
  if (call.state === 'failed' || call.result?.isError) {
    return {
      ...base,
      title: 'The agent was not asked',
      line: call.result?.content.trim() || 'The task could not be handed over.',
      busy: false,
      tone: 'failed',
    };
  }
  const ask = state.ask;
  if (!ask) {
    return {
      ...base,
      title: 'Asked an agent',
      line: state.missing
        ? 'This agent’s run is no longer there to show.'
        : (state.error ?? 'Checking on it…'),
      busy: !state.missing && state.error === null,
      tone: state.missing ? 'failed' : 'neutral',
    };
  }
  const live = askIsLive(ask.phase);
  return {
    task,
    title: ask.agentName,
    line: state.error && live ? `${ask.status} · ${state.error}` : ask.status,
    busy: ask.phase === 'queued' || ask.phase === 'working',
    tone:
      ask.phase === 'waiting'
        ? 'waiting'
        : ask.phase === 'failed' || ask.phase === 'stopped'
          ? 'failed'
          : live
            ? 'neutral'
            : 'done',
    reply: ask.reply,
    runPath: ask.runPath,
    // Once it has answered (or given up), the person can write back to it.
    replyTo: live
      ? null
      : { id: ask.agentId, name: ask.agentName, description: null, ownerName: null, onTeam: false },
  };
}
