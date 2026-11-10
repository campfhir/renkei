import type { OrgUsageReport } from './actions';
import type { ActivityCell, RankedUserRow } from './window';
import {
  addressFor,
  blocked,
  init,
  isHourly,
  modelLine,
  periodOf,
  pickerPeople,
  reducer,
  requestFor,
  statTiles,
  topUsersBoard,
  topUsersHint,
  type UsageViewerAction,
  type UsageViewerState,
} from './usage-viewer.model';
import { ZERO_VOICE_TOTALS } from '@/lib/usage/voice-usage';
import { ZERO_IMAGE_TOTALS } from '@/lib/usage/image-usage';
import { ZERO_DOCUMENT_TOTALS } from '@/lib/usage/document-usage';
import type { PersonProfile } from '@/lib/usage/person-profile';

const zero = { input: 0, output: 0 };

function profile(subject: string, name: string): PersonProfile {
  return { subject, name, email: null, lastActiveAt: null, idpGroups: [], agents: [] };
}

function report(overrides: Partial<OrgUsageReport> = {}): OrgUsageReport {
  return {
    periodKey: '1m',
    days: 30,
    timeZone: 'UTC',
    subject: null,
    person: null,
    people: [
      { subject: 'ada', label: 'Ada' },
      { subject: 'bo', label: 'Bo' },
    ],
    tokens: {
      chat: zero,
      chatProjects: zero,
      images: zero,
      documents: zero,
      codeProjects: zero,
      agents: zero,
    },
    activity: {
      runs: 0,
      failures: 0,
      toolCalls: 0,
      toolErrors: 0,
      activeUsers: 0,
      totalUsers: 0,
    },
    series: [],
    cells: [],
    byModel: [],
    topUsers: [],
    selectedUser: null,
    includeAgentsInTopUsers: false,
    topAgents: [],
    efficientAgents: [],
    topTools: [],
    voice: ZERO_VOICE_TOTALS,
    topListeners: [],
    selectedListener: null,
    topSpeakers: [],
    selectedSpeaker: null,
    image: ZERO_IMAGE_TOTALS,
    document: ZERO_DOCUMENT_TOTALS,
    topImageUsers: [],
    selectedImageUser: null,
    ...overrides,
  };
}

function user(subject: string, rank: number, totalTokens = 1000): RankedUserRow {
  return {
    subject,
    label: subject.toUpperCase(),
    chatTokens: totalTokens,
    agentTokens: 0,
    totalTokens,
    rank,
  };
}

function cell(key: string, active: boolean): ActivityCell {
  return {
    key,
    label: key,
    tokens: active ? 1 : 0,
    runs: 0,
    toolCalls: 0,
    active,
    level: active ? 1 : 0,
  };
}

const fold = (state: UsageViewerState, ...actions: UsageViewerAction[]) =>
  actions.reduce(reducer, state);

const tile = (r: OrgUsageReport, label: string) => statTiles(r).find((t) => t.label === label);

describe('organization usage: the toggles', () => {
  it('opens on the tokens chart, with the top users toggle as the report was counted', () => {
    expect(init(report())).toMatchObject({ series: 'tokens', includeAgents: false });
    expect(init(report({ includeAgentsInTopUsers: true })).includeAgents).toBe(true);
  });

  it('switching the chart series keeps the report it has', () => {
    const start = init(report());
    const state = fold(start, { type: 'seriesPicked', series: 'runs' });
    expect(state.series).toBe('runs');
    expect(state.report).toBe(start.report);
  });

  it('pressing "+ agents" asks for the same period and person, counting agents', () => {
    const state = init(report({ periodKey: '1w', subject: 'ada' }));
    expect(requestFor(state, { kind: 'includeAgents', includeAgents: true })).toEqual({
      periodKey: '1w',
      includeAgents: true,
      subject: 'ada',
    });
    expect(fold(state, { type: 'includeAgentsPicked', includeAgents: true }).includeAgents).toBe(
      true
    );
  });

  it('the toggle stays where it was pressed when the new report arrives', () => {
    const state = fold(
      init(report()),
      { type: 'includeAgentsPicked', includeAgents: true },
      { type: 'reportArrived', report: report({ periodKey: '1q', days: 90 }) }
    );
    expect(state.includeAgents).toBe(true);
    expect(state.report.periodKey).toBe('1q');
  });
});

describe('organization usage: what a press asks for', () => {
  it('a period button keeps the person and the toggle', () => {
    const state = fold(init(report({ subject: 'ada' })), {
      type: 'includeAgentsPicked',
      includeAgents: true,
    });
    expect(requestFor(state, { kind: 'period', periodKey: '1q' })).toEqual({
      periodKey: '1q',
      includeAgents: true,
      subject: 'ada',
    });
  });

  it('a name on a board or in the picker scopes the page to that person in the same period', () => {
    const state = init(report({ periodKey: 'today', days: 1 }));
    expect(requestFor(state, { kind: 'person', subject: 'bo' })).toEqual({
      periodKey: 'today',
      includeAgents: false,
      subject: 'bo',
    });
  });

  it('"Everyone" in the picker asks for the whole organization', () => {
    const state = init(report({ subject: 'ada', periodKey: 'yesterday', days: 1 }));
    expect(requestFor(state, { kind: 'person', subject: '' })).toEqual({
      periodKey: 'yesterday',
      includeAgents: false,
      subject: null,
    });
  });

  it('the address follows the period and the person, and drops the person for everyone', () => {
    const scoped = addressFor('https://renkei.test/admin/usage?period=1m', {
      periodKey: '1q',
      subject: 'ada@example.com',
    });
    expect(new URL(scoped).searchParams.get('period')).toBe('1q');
    expect(new URL(scoped).searchParams.get('user')).toBe('ada@example.com');

    const everyone = addressFor(scoped, { periodKey: 'yesterday', subject: null });
    expect(everyone).toBe('https://renkei.test/admin/usage?period=yesterday');
  });
});

describe('organization usage: what the page shows', () => {
  it('signed out or not an operator shows only why', () => {
    expect(blocked(report())).toBeNull();
    expect(blocked(report({ signedOut: true, error: 'Sign in first.' }))).toEqual({
      heading: 'Sign in required',
      message: 'Sign in first.',
    });
    expect(blocked(report({ forbidden: true, error: 'Operators only.' }))?.heading).toBe(
      'Operator access required'
    );
  });

  it('names the period it covers, and one the buttons do not list by its length', () => {
    expect(periodOf(report({ periodKey: '1q', days: 90 })).label).toBe('90 days');
    expect(periodOf(report({ periodKey: 'custom', days: 14 }))).toEqual({
      key: 'custom',
      label: '14 days',
      days: 14,
      endOffsetDays: 0,
    });
  });

  it('a day or less is counted by the hour', () => {
    expect(isHourly(report({ periodKey: 'today', days: 1 }))).toBe(true);
    expect(isHourly(report({ periodKey: '1w', days: 7 }))).toBe(false);
  });

  it('totals the tokens of every surface but documents, and says how much went to agents', () => {
    const r = report({
      tokens: {
        chat: { input: 1000, output: 500 },
        chatProjects: { input: 500, output: 0 },
        images: { input: 0, output: 1000 },
        documents: { input: 9_000_000, output: 0 },
        codeProjects: zero,
        agents: { input: 2000, output: 1000 },
      },
    });
    expect(tile(r, 'Tokens')).toEqual({ label: 'Tokens', value: '6.0k', hint: '3.0k in agents' });
  });

  it('org-wide, counts the active users against everyone who signed in', () => {
    const r = report({
      activity: {
        runs: 0,
        failures: 0,
        toolCalls: 0,
        toolErrors: 0,
        activeUsers: 3,
        totalUsers: 4,
      },
    });
    expect(tile(r, 'Active users')).toEqual({
      label: 'Active users',
      value: '3 / 4',
      hint: '75% used at least one token',
    });
    expect(tile(r, 'Active days')).toBeUndefined();
  });

  it('scoped to a person, counts their active days instead', () => {
    const r = report({
      subject: 'ada',
      cells: [cell('a', true), cell('b', false), cell('c', true)],
    });
    expect(tile(r, 'Active users')).toBeUndefined();
    expect(tile(r, 'Active days')).toEqual({
      label: 'Active days',
      value: '2 / 3',
      hint: 'days with a token, a run or a tool call',
    });
  });

  it('scoped to a person over one day, counts active hours, and says when there were none', () => {
    const r = report({ subject: 'ada', periodKey: 'today', days: 1, cells: [cell('1 PM', false)] });
    expect(tile(r, 'Active hours')).toEqual({
      label: 'Active hours',
      value: '0 / 1',
      hint: 'nothing in this period',
    });
  });

  it('says how many runs and tool calls failed, none failed, or nothing when there were none', () => {
    const failing = report({
      activity: {
        runs: 8,
        failures: 2,
        toolCalls: 1200,
        toolErrors: 3,
        activeUsers: 0,
        totalUsers: 0,
      },
    });
    expect(tile(failing, 'Agent runs')).toEqual({
      label: 'Agent runs',
      value: '8',
      hint: '2 failed (25%)',
    });
    expect(tile(failing, 'Tool calls')).toEqual({
      label: 'Tool calls',
      value: '1,200',
      hint: '3 failed (0.3%)',
    });

    const clean = report({
      activity: {
        runs: 4,
        failures: 0,
        toolCalls: 9,
        toolErrors: 0,
        activeUsers: 0,
        totalUsers: 0,
      },
    });
    expect(tile(clean, 'Agent runs')?.hint).toBe('none failed');
    expect(tile(clean, 'Tool calls')?.hint).toBe('none failed');

    expect(tile(report(), 'Agent runs')?.hint).toBeUndefined();
    expect(tile(report(), 'Tool calls')?.hint).toBeUndefined();
  });

  it('gives each model its tokens, its share and its calls', () => {
    const byModel = [
      {
        provider: 'p',
        model: 'a',
        inputTokens: 3000,
        outputTokens: 0,
        cachedInputTokens: 0,
        calls: 1234,
      },
      {
        provider: 'p',
        model: 'b',
        inputTokens: 500,
        outputTokens: 500,
        cachedInputTokens: 0,
        calls: 1,
      },
    ];
    expect(modelLine(byModel[0], byModel)).toBe('3.0k · 75% · 1,234 calls');
    expect(modelLine(byModel[1], byModel)).toBe('1.0k · 25% · 1 calls');
  });
});

describe('organization usage: the top users board', () => {
  const top = [user('a', 1), user('b', 2), user('c', 3)];

  it('shows the top few when nobody is picked', () => {
    expect(topUsersBoard(report({ topUsers: top }))).toEqual({ rows: top, gapAtRank: null });
  });

  it('highlights a picked person inside the top without adding a row', () => {
    expect(topUsersBoard(report({ topUsers: top, selectedUser: user('b', 2) }))).toEqual({
      rows: top,
      gapAtRank: null,
    });
  });

  it('adds a picked person ranked below the top, after a gap when ranks are skipped', () => {
    const far = user('z', 9);
    expect(topUsersBoard(report({ topUsers: top, selectedUser: far }))).toEqual({
      rows: [...top, far],
      gapAtRank: 9,
    });
  });

  it('adds the next rank straight after the top with no gap', () => {
    const next = user('d', 4);
    expect(topUsersBoard(report({ topUsers: top, selectedUser: next }))).toEqual({
      rows: [...top, next],
      gapAtRank: null,
    });
  });

  it('says what it counts, by the toggle', () => {
    expect(topUsersHint(init(report()))).toBe(
      'Chat, chat-project and code-project tokens — toggle above to fold in their agents. Pick a name to scope the page to that person.'
    );
    expect(topUsersHint(init(report({ includeAgentsInTopUsers: true })))).toBe(
      'Chat, chat-project, code-project and agent tokens combined. Pick a name to scope the page to that person.'
    );
  });

  it('says a picked person spent nothing when they are not on it', () => {
    const r = report({
      subject: 'ada',
      person: profile('ada', 'Ada Lovelace'),
    });
    expect(topUsersHint(init(r))).toBe(
      'Ada Lovelace spent no tokens in this period. Chat, chat-project and code-project tokens — toggle above to fold in their agents.'
    );
  });
});

describe('organization usage: the person picker', () => {
  it('lists everyone who signed in', () => {
    expect(pickerPeople(report()).map((p) => p.subject)).toEqual(['ada', 'bo']);
    expect(pickerPeople(report({ subject: 'bo' })).map((p) => p.subject)).toEqual(['ada', 'bo']);
  });

  it('lists a person reached by link who never signed in first, rather than snapping to Everyone', () => {
    expect(pickerPeople(report({ subject: 'grant-owner' }))).toEqual([
      { subject: 'grant-owner', label: 'grant-owner' },
      { subject: 'ada', label: 'Ada' },
      { subject: 'bo', label: 'Bo' },
    ]);
    const named = report({
      subject: 'cy',
      person: profile('cy', 'Cy Young'),
    });
    expect(pickerPeople(named)[0]).toEqual({ subject: 'cy', label: 'Cy Young' });
  });
});
