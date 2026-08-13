/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The two Jira collectors, and the distinction between them.
 *
 * A sprint is a state with its own dates; work items are a window. The tests
 * that matter are the ones proving each honours the right notion of time.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn(() => ({ ok: false })) }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('../common', () => ({
  jiraFetch: jest.fn(),
  withPresentationHint: (text: string) => text,
}));

import { collectSprint, collectWorkItems } from './collect-jira';
import { resolvePeriod } from './period';
import type { MCPToolContext } from '../common';

const { jiraFetch: mockFetch } = jest.requireMock<{ jiraFetch: jest.Mock }>('../common');

const context = (): MCPToolContext =>
  ({ apiBaseUrl: 'https://api.example', accessToken: 'token' }) as unknown as MCPToolContext;

const json = (body: unknown) => ({ ok: true, json: async () => body });

/** The Agile sprint field as Jira reports it in /field. */
const FIELD_LIST = [
  { id: 'customfield_10020', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
  { id: 'customfield_10001', schema: { custom: 'something.else' } },
];

const issue = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  fields: {
    summary: `Work on ${key}`,
    status: { name: 'In Progress' },
    priority: { name: 'High' },
    updated: '2026-08-12T10:30:00.000Z',
    ...over,
  },
});

beforeEach(() => jest.clearAllMocks());

describe('collectSprint', () => {
  it('reads the sprint window off the issues, with no board involved', async () => {
    const sprintField = [
      {
        name: 'Sprint 14',
        state: 'active',
        startDate: '2026-08-10T00:00:00Z',
        endDate: '2026-08-24T00:00:00Z',
      },
    ];
    mockFetch
      .mockResolvedValueOnce(json(FIELD_LIST))
      .mockResolvedValueOnce(json({ issues: [issue('ENG-1', { customfield_10020: sprintField })] }))
      .mockResolvedValueOnce(json({ issues: [] }));

    const section = await collectSprint(
      context(),
      resolvePeriod({ period: 'today' }),
      new Date('2026-08-17T00:00:00Z')
    );

    expect(section?.lines[0]).toContain('Sprint 14');
    expect(section?.lines[0]).toContain('2026-08-10 → 2026-08-24');
    // The number people actually want from a sprint header.
    expect(section?.lines[0]).toContain('7d left');
  });

  it('still lists issues when the sprint field cannot be resolved', async () => {
    // Dates are worth having, not worth failing over.
    mockFetch
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(json({ issues: [issue('ENG-1')] }))
      .mockResolvedValueOnce(json({ issues: [] }));

    const section = await collectSprint(context(), resolvePeriod({}));
    expect(section?.lines.join('\n')).toContain('ENG-1');
    expect(section?.omitted).toContain('sprint dates unavailable');
  });

  it('ignores the period, because a sprint is a state rather than a window', async () => {
    mockFetch.mockResolvedValue(json({ issues: [issue('ENG-1')] }));

    await collectSprint(context(), resolvePeriod({ period: 'yesterday' }));

    // Every JQL sent is scoped by openSprints(), never by a date.
    const jqls = mockFetch.mock.calls
      .map((call) => String(call[2]?.body ?? ''))
      .filter(Boolean)
      .map((body) => String(JSON.parse(body).jql));
    expect(jqls.length).toBeGreaterThan(0);
    for (const jql of jqls) {
      expect(jql).toContain('openSprints()');
      expect(jql).not.toContain('updated >=');
    }
  });

  it('separates what is yours from the rest of the sprint', async () => {
    mockFetch
      .mockResolvedValueOnce(json(FIELD_LIST))
      .mockResolvedValueOnce(json({ issues: [issue('ENG-1')] }))
      .mockResolvedValueOnce(
        json({ issues: [issue('ENG-9', { assignee: { displayName: 'Sam' } })] })
      );

    const section = await collectSprint(context(), resolvePeriod({}));
    const text = section?.lines.join('\n') ?? '';
    expect(text).toContain('Assigned to you:');
    expect(text).toContain('Elsewhere in the sprint');
    expect(text).toContain('Sam');
    expect(section?.headline).toBe('1 assigned to you');
  });
});

describe('collectWorkItems', () => {
  it('bounds by the period, which is the whole point of it', async () => {
    mockFetch.mockResolvedValueOnce(json({ issues: [issue('ENG-2')] }));

    await collectWorkItems(
      context(),
      resolvePeriod({ period: 'yesterday', timeZone: 'UTC' }, new Date('2026-08-12T09:00:00Z'))
    );

    const jql = String(JSON.parse(String(mockFetch.mock.calls[0]![2]?.body)).jql);
    expect(jql).toContain('updated >= "2026-08-11 00:00"');
    expect(jql).toContain('updated < "2026-08-12 00:00"');
    // Jira rejects a raw ISO instant in JQL, so the T must be gone.
    expect(jql).not.toContain('T00:00');
  });

  it('returns nothing rather than an empty section when nothing moved', async () => {
    mockFetch.mockResolvedValueOnce(json({ issues: [] }));
    expect(await collectWorkItems(context(), resolvePeriod({}))).toBeNull();
  });

  it('says the list is limited to issues the caller owns or reported', async () => {
    mockFetch.mockResolvedValueOnce(json({ issues: [issue('ENG-2')] }));
    const section = await collectWorkItems(context(), resolvePeriod({}));
    expect(section?.omitted).toContain('own or reported');
  });
});
