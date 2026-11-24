import type { AgentAskView } from '@/lib/chat/agent-ask-view';
import {
  agentAskCardReducer,
  agentAskCardView,
  initialAgentAskCard,
  shouldPoll,
  type AgentAskCardAction,
} from './agent-ask-card.model';

const ask = (patch: Partial<AgentAskView> = {}): AgentAskView => ({
  runId: 'run-1',
  agentId: 'agent-1',
  agentName: 'Triage',
  phase: 'working',
  status: 'Triage is working on it',
  reply: null,
  runPath: '/agents/agent-1/runs/run-1',
  askedAt: '2026-11-17T10:00:00.000Z',
  finishedAt: null,
  ...patch,
});

const fold = (actions: AgentAskCardAction[]) => actions.reduce(agentAskCardReducer, initialAgentAskCard);
const input = { agent_id: 'agent-1', task: 'Look into INC-42 and say who owns it' };
const done = { state: 'done' as const, input, result: { content: 'Triage has the task' } };

describe('an agent’s card in the thread', () => {
  it('waits for the person’s OK before anything is handed over, and does not ask the server', () => {
    const view = agentAskCardView({ state: 'waiting', input, result: null }, initialAgentAskCard);
    expect(view.title).toBe('Ask an agent?');
    expect(view.task).toBe('Look into INC-42 and say who owns it');
    expect(shouldPoll('waiting', initialAgentAskCard)).toBe(false);
  });

  it('a refused ask says why, in the server’s words', () => {
    const view = agentAskCardView(
      {
        state: 'done',
        input,
        result: { content: 'Triage is turned off, so it cannot be asked.', isError: true },
      },
      initialAgentAskCard
    );
    expect(view).toMatchObject({ title: 'The agent was not asked', tone: 'failed' });
    expect(view.line).toContain('turned off');
  });

  it('once handed over it keeps checking while the agent works', () => {
    const state = fold([{ type: 'loaded', ask: ask() }]);
    const view = agentAskCardView(done, state);
    expect(view).toMatchObject({ title: 'Triage', line: 'Triage is working on it', busy: true });
    expect(view.replyTo).toBeNull();
    expect(shouldPoll('done', state)).toBe(true);
  });

  it('a run waiting on an approval reads as waiting, and is still checked on', () => {
    const state = fold([
      { type: 'loaded', ask: ask({ phase: 'waiting', status: 'Waiting for a person to approve or answer Triage' }) },
    ]);
    expect(agentAskCardView(done, state).tone).toBe('waiting');
    expect(shouldPoll('done', state)).toBe(true);
  });

  it('the reply shows under the request, checking stops, and the person can write back', () => {
    const state = fold([
      { type: 'loaded', ask: ask({ phase: 'replied', status: 'Triage replied', reply: 'Ada owns it.' }) },
    ]);
    const view = agentAskCardView(done, state);
    expect(view).toMatchObject({ reply: 'Ada owns it.', tone: 'done', busy: false });
    expect(view.replyTo).toMatchObject({ id: 'agent-1', name: 'Triage' });
    expect(view.runPath).toBe('/agents/agent-1/runs/run-1');
    expect(shouldPoll('done', state)).toBe(false);
  });

  it('a failed check keeps the last status and says the check failed', () => {
    const state = fold([
      { type: 'loaded', ask: ask() },
      { type: 'loadFailed', message: 'Could not reach the server', notFound: false },
    ]);
    expect(agentAskCardView(done, state).line).toBe(
      'Triage is working on it · Could not reach the server'
    );
    expect(shouldPoll('done', state)).toBe(true);
  });

  it('a run that is gone stops the checking and says so', () => {
    const state = fold([{ type: 'loadFailed', message: 'No agent was asked', notFound: true }]);
    expect(agentAskCardView(done, state).line).toBe('This agent’s run is no longer there to show.');
    expect(shouldPoll('done', state)).toBe(false);
  });
});
