import {
  askIsLive,
  askPhaseOf,
  orderAskable,
  replyOfAttempts,
  type AskableAgent,
} from './agent-ask-view';

const agent = (id: string, name: string, extra: Partial<AskableAgent> = {}): AskableAgent => ({
  id,
  name,
  description: null,
  ownerName: null,
  onTeam: false,
  ...extra,
});

describe('where a task handed to an agent stands', () => {
  it('a queued, running or waiting run is live; an ended one is not', () => {
    expect(askPhaseOf('queued', null, 'Triage').phase).toBe('queued');
    expect(askPhaseOf('running', null, 'Triage')).toEqual({
      phase: 'working',
      status: 'Triage is working on it',
    });
    expect(askIsLive(askPhaseOf('waiting', null, 'Triage').phase)).toBe(true);
    expect(askIsLive(askPhaseOf('succeeded', null, 'Triage').phase)).toBe(false);
  });

  it('a run parked for its owner’s sign-in says so, not that it waits on an approval', () => {
    expect(askPhaseOf('waiting', 'needs-sign-in', 'Triage').status).toBe(
      'Paused until Triage’s owner signs in again'
    );
    expect(askPhaseOf('waiting', null, 'Triage').status).toBe(
      'Waiting for a person to approve or answer Triage'
    );
  });

  it('nothing to do, a failure and a stop each read as themselves', () => {
    expect(askPhaseOf('stopped', null, 'Triage').phase).toBe('nothing');
    expect(askPhaseOf('failed', 'model', 'Triage').phase).toBe('failed');
    expect(askPhaseOf('canceled', null, 'Triage').phase).toBe('stopped');
  });
});

describe('what the agent answered', () => {
  it('the finishing turn’s result, which the run was told is its reply', () => {
    expect(
      replyOfAttempts([
        { detail: { assistant: 'thinking' } },
        { detail: { finish: 'done', llmSummary: 'Looked it up.', result: 'Ada owns INC-42.' } },
      ])
    ).toBe('Ada owns INC-42.');
  });

  it('the finish summary when the run left no result, and nothing before it finished', () => {
    expect(replyOfAttempts([{ detail: { finish: 'done', llmSummary: 'Done.' } }])).toBe('Done.');
    expect(replyOfAttempts([{ detail: { assistant: 'still going' } }, {}])).toBeNull();
  });
});

describe('the order agents are offered in', () => {
  it('the team in the order it was put together, then own agents, then shared, each by name', () => {
    const ordered = orderAskable([
      agent('1', 'Zed'),
      agent('2', 'Shared', { ownerName: 'Ada' }),
      agent('3', 'Team B', { onTeam: true }),
      agent('4', 'Alpha'),
      agent('5', 'Team A', { onTeam: true }),
    ]);
    expect(ordered.map((a) => a.name)).toEqual(['Team B', 'Team A', 'Alpha', 'Zed', 'Shared']);
  });

  it('a query narrows by name or description, ignoring case', () => {
    const agents = [agent('1', 'Triage', { description: 'Support queue' }), agent('2', 'Billing')];
    expect(orderAskable(agents, 'QUEUE').map((a) => a.name)).toEqual(['Triage']);
    expect(orderAskable(agents, 'bill').map((a) => a.name)).toEqual(['Billing']);
  });
});
