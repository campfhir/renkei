/**
 * Addressing a message to an agent from the composer, with no React: the
 * person types `@` (or presses "Ask an agent") and picks one of their
 * agents — the project's team first — and the message goes to that agent
 * (lib/chat/agent-ask-view.ts): the chat hands it the task without asking
 * again. The pick is a chip over the box ("To Triage ×"), not text in it,
 * so editing the message never half-deletes a name; on Send the message
 * goes out as `@Triage …`, so the person's bubble and the chat's history
 * both read who it was for.
 *
 * agent-mention.tsx renders from this and makes the one call (the list of
 * agents). Tested in agent-mention.model.test.ts.
 */

import { orderAskable, type AskableAgent } from '@/lib/chat/agent-ask-view';

/** How many agents the list shows at once; typing narrows it. */
export const MENTION_LIMIT = 8;

interface Mention {
  /** Where the `@` is in the text. */
  start: number;
  /** What follows it, up to the caret. */
  query: string;
  /** The caret, so a pick knows where the query ends. */
  end: number;
}

export interface AgentMentionState {
  /** The agents the person may ask; null until loaded. */
  agents: AskableAgent[] | null;
  /** Who the next message goes to; null for the chat itself. */
  addressee: AskableAgent | null;
  /** The `@` the caret is in, if any. */
  mention: Mention | null;
  /** The list opened from the button, with no `@` typed. */
  browsing: boolean;
  /** The `@` Escape put away: nothing shows for it until the caret leaves it. */
  dismissedStart: number | null;
  /** The highlighted row. */
  active: number;
}

export type AgentMentionAction =
  | { type: 'agentsLoaded'; agents: AskableAgent[] }
  /** The text or the caret moved. */
  | { type: 'caretMoved'; text: string; caret: number }
  | { type: 'browseToggled' }
  | { type: 'moved'; by: 1 | -1 }
  | { type: 'dismissed' }
  /** A row taken, from the list. */
  | { type: 'picked'; agent: AskableAgent }
  /** Addressed from elsewhere — "Reply" on an agent's card in the thread. */
  | { type: 'addressed'; agent: AskableAgent }
  | { type: 'cleared' }
  /** The message went out: the next one is for the chat again. */
  | { type: 'sent' };

export const initialAgentMention: AgentMentionState = {
  agents: null,
  addressee: null,
  mention: null,
  browsing: false,
  dismissedStart: null,
  active: 0,
};

/** The `@` the caret is in: `@` at a word's start, no space since. */
export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { start: at, query, end: caret };
}

const sameMention = (a: Mention | null, b: Mention | null) =>
  a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end && a.query === b.query);

export function agentMentionReducer(
  state: AgentMentionState,
  action: AgentMentionAction
): AgentMentionState {
  switch (action.type) {
    case 'agentsLoaded':
      return {
        ...state,
        agents: action.agents,
        // An addressee no longer offered (unshared, turned off) is dropped.
        addressee:
          state.addressee && action.agents.some((agent) => agent.id === state.addressee?.id)
            ? state.addressee
            : null,
      };
    case 'caretMoved': {
      const mention = mentionAt(action.text, action.caret);
      if (sameMention(mention, state.mention)) return state;
      return {
        ...state,
        mention,
        // An `@` typed takes over from the button's list.
        browsing: mention ? false : state.browsing,
        dismissedStart:
          mention && state.dismissedStart === mention.start ? state.dismissedStart : null,
        active: 0,
      };
    }
    case 'browseToggled':
      return { ...state, browsing: !state.browsing, mention: null, active: 0 };
    case 'moved': {
      const count = mentionOptions(state).length;
      if (count === 0) return state;
      return { ...state, active: (state.active + action.by + count) % count };
    }
    case 'dismissed':
      return {
        ...state,
        browsing: false,
        dismissedStart: state.mention ? state.mention.start : state.dismissedStart,
      };
    case 'picked':
    case 'addressed':
      return {
        ...state,
        addressee: action.agent,
        mention: null,
        browsing: false,
        dismissedStart: null,
        active: 0,
      };
    case 'cleared':
      return { ...state, addressee: null };
    case 'sent':
      return { ...state, addressee: null, mention: null, browsing: false, active: 0 };
  }
}

/** The rows the list shows: the agents matching what follows the `@`, team first. */
export function mentionOptions(state: AgentMentionState): AskableAgent[] {
  if (!state.agents) return [];
  const query = state.mention?.query ?? '';
  return orderAskable(state.agents, query).slice(0, MENTION_LIMIT);
}

/** Whether the list is up. Not for a person with no agent to ask: `@` stays an ordinary character. */
export function mentionOpen(state: AgentMentionState): boolean {
  if (!state.agents || state.agents.length === 0) return false;
  if (state.browsing) return true;
  return state.mention !== null && state.dismissedStart !== state.mention.start;
}

/** The row Enter or Tab takes, when the list is up and has one. */
export function activeOption(state: AgentMentionState): AskableAgent | null {
  if (!mentionOpen(state)) return null;
  const options = mentionOptions(state);
  return options[state.active] ?? options[0] ?? null;
}

/** The box's text once a row is taken: the `@query` the person typed goes (the chip says it). */
export function textAfterPick(
  text: string,
  mention: Mention | null
): { text: string; caret: number | null } {
  if (!mention) return { text, caret: null };
  const after = text.slice(mention.end).replace(/^ /, '');
  return { text: text.slice(0, mention.start) + after, caret: mention.start };
}

/** What Send sends for a message addressed to an agent: its name up front, as people write it. */
export function addressedText(text: string, addressee: AskableAgent | null): string {
  if (!addressee) return text;
  const tag = `@${addressee.name}`;
  return text.trimStart().startsWith(tag) ? text : `${tag} ${text.trimStart()}`;
}

/** The chip's words, and what its × says to a screen reader. */
export function addresseeChip(addressee: AskableAgent): { label: string; clear: string } {
  return { label: `To ${addressee.name}`, clear: `Send to the chat instead of ${addressee.name}` };
}

/** What the box says while empty: how to reach an agent, once there is one to reach. */
export function mentionHint(state: AgentMentionState): string | null {
  if (state.addressee) return `Message ${state.addressee.name}…`;
  if (state.agents && state.agents.length > 0) return 'Type @ to ask one of your agents';
  return null;
}

/** One row's second line: why it is offered. */
export function optionNote(agent: AskableAgent): string | null {
  const whose = agent.ownerName ? `${agent.ownerName}’s agent` : null;
  const team = agent.onTeam ? 'On this project’s team' : null;
  const parts = [team, whose, agent.description].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** How many agents an empty chat suggests by name. */
export const HINT_LIMIT = 4;

/**
 * What an empty chat says about agents: the first few to ask (the team
 * first) and how many more there are — or, for someone with none, that
 * they could make one.
 */
export function emptyChatAgents(
  agents: readonly AskableAgent[] | null
): { kind: 'loading' } | { kind: 'none' } | { kind: 'some'; shown: AskableAgent[]; more: number } {
  if (agents === null) return { kind: 'loading' };
  if (agents.length === 0) return { kind: 'none' };
  const ordered = orderAskable(agents);
  return {
    kind: 'some',
    shown: ordered.slice(0, HINT_LIMIT),
    more: Math.max(0, ordered.length - HINT_LIMIT),
  };
}
