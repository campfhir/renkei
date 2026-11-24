import type { AskableAgent } from '@/lib/chat/agent-ask-view';
import {
  activeOption,
  addressedText,
  emptyChatAgents,
  agentMentionReducer,
  initialAgentMention,
  mentionHint,
  mentionOpen,
  mentionOptions,
  textAfterPick,
  type AgentMentionAction,
  type AgentMentionState,
} from './agent-mention.model';

const agent = (id: string, name: string, extra: Partial<AskableAgent> = {}): AskableAgent => ({
  id,
  name,
  description: null,
  ownerName: null,
  onTeam: false,
  ...extra,
});

const triage = agent('a1', 'Triage', { description: 'Sorts the support queue' });
const billing = agent('a2', 'Billing', { onTeam: true });
const shared = agent('a3', 'Access reviews', { ownerName: 'Ada' });

const fold = (actions: AgentMentionAction[], from: AgentMentionState = initialAgentMention) =>
  actions.reduce(agentMentionReducer, from);

const loaded = fold([{ type: 'agentsLoaded', agents: [triage, billing, shared] }]);

describe('addressing a message to an agent from the composer', () => {
  it('typing @ at the start of a word opens the list, the team first, then own, then shared', () => {
    const state = fold([{ type: 'caretMoved', text: 'please @', caret: 8 }], loaded);
    expect(mentionOpen(state)).toBe(true);
    expect(mentionOptions(state).map((a) => a.name)).toEqual(['Billing', 'Triage', 'Access reviews']);
  });

  it('what follows the @ narrows the list by name or description', () => {
    const state = fold([{ type: 'caretMoved', text: '@supp', caret: 5 }], loaded);
    expect(mentionOptions(state).map((a) => a.name)).toEqual(['Triage']);
  });

  it('an @ inside a word, like an email address, opens nothing', () => {
    const state = fold([{ type: 'caretMoved', text: 'mail ada@', caret: 9 }], loaded);
    expect(mentionOpen(state)).toBe(false);
  });

  it('someone with no agents to ask types @ as an ordinary character', () => {
    const none = fold([
      { type: 'agentsLoaded', agents: [] },
      { type: 'caretMoved', text: '@', caret: 1 },
    ]);
    expect(mentionOpen(none)).toBe(false);
    expect(mentionHint(none)).toBeNull();
  });

  it('arrows move the highlight round the list, and Enter takes the highlighted agent', () => {
    const state = fold(
      [
        { type: 'caretMoved', text: '@', caret: 1 },
        { type: 'moved', by: 1 },
        { type: 'moved', by: 1 },
        { type: 'moved', by: 1 },
        { type: 'moved', by: -1 },
      ],
      loaded
    );
    expect(activeOption(state)?.name).toBe('Access reviews');
  });

  it('picking an agent puts it on the chip and takes the typed @name out of the box', () => {
    const typing = fold([{ type: 'caretMoved', text: 'hey @tri can you', caret: 8 }], loaded);
    const after = textAfterPick('hey @tri can you', typing.mention);
    const picked = fold([{ type: 'picked', agent: triage }], typing);
    expect(after).toEqual({ text: 'hey can you', caret: 4 });
    expect(picked.addressee?.name).toBe('Triage');
    expect(mentionOpen(picked)).toBe(false);
    expect(mentionHint(picked)).toBe('Message Triage…');
  });

  it('Escape puts the list away until the caret leaves that @', () => {
    const away = fold(
      [
        { type: 'caretMoved', text: '@b', caret: 2 },
        { type: 'dismissed' },
        { type: 'caretMoved', text: '@bi', caret: 3 },
      ],
      loaded
    );
    expect(mentionOpen(away)).toBe(false);
    const again = fold([{ type: 'caretMoved', text: '@bi @', caret: 5 }], away);
    expect(mentionOpen(again)).toBe(true);
  });

  it('the Ask an agent button opens the whole list without typing', () => {
    const state = fold([{ type: 'browseToggled' }], loaded);
    expect(mentionOpen(state)).toBe(true);
    expect(mentionOptions(state)).toHaveLength(3);
  });

  it('a message to an agent goes out with its name up front, once', () => {
    expect(addressedText('look at INC-42', triage)).toBe('@Triage look at INC-42');
    expect(addressedText('@Triage look at INC-42', triage)).toBe('@Triage look at INC-42');
    expect(addressedText('look at INC-42', null)).toBe('look at INC-42');
  });

  it('after Send the next message is for the chat again', () => {
    const state = fold([{ type: 'picked', agent: triage }, { type: 'sent' }], loaded);
    expect(state.addressee).toBeNull();
    expect(mentionHint(state)).toBe('Type @ to ask one of your agents');
  });

  it('Reply on an agent’s card addresses the composer to it', () => {
    expect(fold([{ type: 'addressed', agent: billing }], loaded).addressee?.id).toBe('a2');
  });

  it('an addressee that is no longer offered when the list reloads is dropped', () => {
    const state = fold(
      [
        { type: 'picked', agent: shared },
        { type: 'agentsLoaded', agents: [triage] },
      ],
      loaded
    );
    expect(state.addressee).toBeNull();
  });
});

describe('what an empty chat says about agents', () => {
  it('names the first few to ask, the team first, and counts the rest', () => {
    const many = [triage, billing, shared, agent('a4', 'Zed'), agent('a5', 'Yan')];
    const hint = emptyChatAgents(many);
    expect(hint.kind).toBe('some');
    if (hint.kind !== 'some') return;
    expect(hint.shown.map((a) => a.name)).toEqual(['Billing', 'Triage', 'Yan', 'Zed']);
    expect(hint.more).toBe(1);
  });

  it('someone with no agents is told they could make one; nothing shows while loading', () => {
    expect(emptyChatAgents([])).toEqual({ kind: 'none' });
    expect(emptyChatAgents(null)).toEqual({ kind: 'loading' });
  });
});
