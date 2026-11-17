/**
 * A chat project's team, with no React (project-team-card.tsx): the
 * agents the project's chats offer first when someone hands a task to an
 * agent (lib/chat/agent-asks.ts). Who is on it, adding one of your own
 * agents (or one shared with you), taking one off, and what a refusal
 * leaves on screen. Tested in project-team.model.test.ts.
 */

import type { AskableAgent, ProjectTeamMember } from '@/lib/chat/agent-ask-view';

export interface ProjectTeamState {
  /** Null until loaded. */
  team: ProjectTeamMember[] | null;
  /** The agents the viewer could add; null until the picker first opens and loads. */
  candidates: AskableAgent[] | null;
  picking: boolean;
  /** The agent being added or taken off, while its request is out. */
  busy: string | null;
  error: string | null;
}

export type ProjectTeamAction =
  | { type: 'teamLoaded'; team: ProjectTeamMember[] }
  | { type: 'candidatesLoaded'; agents: AskableAgent[] }
  | { type: 'pickerToggled' }
  | { type: 'changePressed'; agentId: string }
  /** The server's answer to an add or a removal: the team as it now stands. */
  | { type: 'changed'; team: ProjectTeamMember[] }
  | { type: 'refused'; message: string };

export const initialProjectTeam: ProjectTeamState = {
  team: null,
  candidates: null,
  picking: false,
  busy: null,
  error: null,
};

export function projectTeamReducer(
  state: ProjectTeamState,
  action: ProjectTeamAction
): ProjectTeamState {
  switch (action.type) {
    case 'teamLoaded':
      return { ...state, team: action.team };
    case 'candidatesLoaded':
      return { ...state, candidates: action.agents };
    case 'pickerToggled':
      return { ...state, picking: !state.picking, error: null };
    case 'changePressed':
      return { ...state, busy: action.agentId, error: null };
    case 'changed':
      // An agent added closes the picker; a removal leaves it as it was.
      return {
        ...state,
        team: action.team,
        busy: null,
        picking: state.picking && !action.team.some((m) => m.agentId === state.busy),
      };
    case 'refused':
      return { ...state, busy: null, error: action.message };
  }
}

/** The agents the picker offers: the viewer's askable agents not already on the team. */
export function addableAgents(state: ProjectTeamState): AskableAgent[] {
  if (!state.candidates) return [];
  const onTeam = new Set((state.team ?? []).map((member) => member.agentId));
  return state.candidates.filter((agent) => !onTeam.has(agent.id));
}

/** The line under a member's name: whose it is, and whether this viewer can ask it. */
export function memberNote(member: ProjectTeamMember): string {
  const whose = member.ownerName === 'You' ? 'Your agent' : `${member.ownerName}’s agent`;
  return member.canAsk ? whose : `${whose} · not shared with you, so you can’t ask it`;
}

/** What the card says while the team is empty. */
export function emptyTeamText(canEdit: boolean): string {
  return canEdit
    ? 'Add the agents that work on this project. Its chats offer them first: type @ in a chat, or let the chat suggest one, and the agent takes the task and replies in the chat.'
    : 'No agents are on this project’s team yet.';
}
