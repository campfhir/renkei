import type { AskableAgent, ProjectTeamMember } from '@/lib/chat/agent-ask-view';
import {
  addableAgents,
  emptyTeamText,
  initialProjectTeam,
  memberNote,
  projectTeamReducer,
  type ProjectTeamAction,
} from './project-team.model';

const member = (agentId: string, name: string, patch: Partial<ProjectTeamMember> = {}) => ({
  agentId,
  name,
  description: null,
  ownerName: 'You',
  canAsk: true,
  ...patch,
});
const askable = (id: string, name: string): AskableAgent => ({
  id,
  name,
  description: null,
  ownerName: null,
  onTeam: false,
});

const fold = (actions: ProjectTeamAction[]) => actions.reduce(projectTeamReducer, initialProjectTeam);

describe('a chat project’s team', () => {
  it('the picker offers only agents not already on the team', () => {
    const state = fold([
      { type: 'teamLoaded', team: [member('a1', 'Triage')] },
      { type: 'pickerToggled' },
      { type: 'candidatesLoaded', agents: [askable('a1', 'Triage'), askable('a2', 'Billing')] },
    ]);
    expect(addableAgents(state).map((a) => a.name)).toEqual(['Billing']);
  });

  it('adding an agent shows the new team and closes the picker', () => {
    const state = fold([
      { type: 'teamLoaded', team: [] },
      { type: 'pickerToggled' },
      { type: 'changePressed', agentId: 'a2' },
      { type: 'changed', team: [member('a2', 'Billing')] },
    ]);
    expect(state.team?.map((m) => m.name)).toEqual(['Billing']);
    expect(state.picking).toBe(false);
    expect(state.busy).toBeNull();
  });

  it('taking an agent off leaves the picker as it was', () => {
    const state = fold([
      { type: 'teamLoaded', team: [member('a1', 'Triage')] },
      { type: 'changePressed', agentId: 'a1' },
      { type: 'changed', team: [] },
    ]);
    expect(state.team).toEqual([]);
    expect(state.picking).toBe(false);
  });

  it('a refused change keeps the team and says why', () => {
    const state = fold([
      { type: 'teamLoaded', team: [member('a1', 'Triage')] },
      { type: 'changePressed', agentId: 'a2' },
      { type: 'refused', message: 'Billing is already on this team.' },
    ]);
    expect(state.team).toHaveLength(1);
    expect(state.error).toBe('Billing is already on this team.');
    expect(state.busy).toBeNull();
  });

  it('a member says whose agent it is, and when the viewer cannot ask it', () => {
    expect(memberNote(member('a1', 'Triage'))).toBe('Your agent');
    expect(memberNote(member('a2', 'Billing', { ownerName: 'Ada', canAsk: false }))).toBe(
      'Ada’s agent · not shared with you, so you can’t ask it'
    );
  });

  it('an empty team tells an editor what a team is for', () => {
    expect(emptyTeamText(true)).toContain('type @ in a chat');
    expect(emptyTeamText(false)).toBe('No agents are on this project’s team yet.');
  });
});
