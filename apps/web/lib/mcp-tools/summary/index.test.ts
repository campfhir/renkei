/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The summary orchestrator.
 *
 * Two properties carry the feature and both are failure-shaped: one broken
 * connector must not take the brief with it, and a truncated list must never
 * be presentable as the whole. The rest is plumbing.
 */

// The orchestrator reaches ../common for withPresentationHint, which pulls in
// @renkei/db and its ESM kysely import that jest's CJS runtime cannot parse.
// Stubbed rather than migrated, matching the other tool suites here.
jest.mock('@renkei/db', () => ({ getDatabase: jest.fn(() => ({ ok: false })) }));
jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerSummaryTools } from './index';
import type { SummaryProvider, SummarySection } from './types';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function toolsOf(providers: SummaryProvider[]): Map<string, Handler> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  registerSummaryTools(server, {} as unknown as MCPToolContext, providers);
  return registered;
}

const provider = (
  connector: string,
  label: string,
  result: SummarySection | null
): SummaryProvider => ({
  connector,
  label,
  toolName: `${connector}_summary`,
  collect: async () => result,
});

/** A provider whose source is down, to prove one failure stays contained. */
const failingProvider = (connector: string, label: string): SummaryProvider => ({
  connector,
  label,
  toolName: `${connector}_summary`,
  collect: async () => {
    throw new Error('upstream exploded');
  },
});

const textOf = (result: { content: { text: string }[] }) => result.content[0]?.text ?? '';

const section = (over: Partial<SummarySection> = {}): SummarySection => ({
  connector: 'jira',
  label: 'Sprint',
  lines: ['ENG-1 [In Progress] Fix the thing'],
  ...over,
});

describe('daily_summary', () => {
  it('composes every available source into one brief', async () => {
    const tools = toolsOf([
      provider('jira', 'Sprint', section()),
      provider(
        'microsoft',
        'Calendar',
        section({ connector: 'microsoft', label: 'Calendar', lines: ['09:00 Standup'] })
      ),
    ]);

    const text = textOf(await tools.get('daily_summary')!({ period: 'today', timeZone: 'UTC' }));
    expect(text).toContain('Sprint');
    expect(text).toContain('ENG-1');
    expect(text).toContain('Calendar');
    expect(text).toContain('09:00 Standup');
  });

  it('keeps going when one connector throws', async () => {
    // A brief that returns nothing because Confluence is down is worse than
    // one that returns everything else and says so.
    const tools = toolsOf([
      provider('jira', 'Sprint', section()),
      failingProvider('atlassian-confluence', 'Confluence'),
    ]);

    const text = textOf(await tools.get('daily_summary')!({}));
    expect(text).toContain('ENG-1');
    expect(text).toContain('could not be read');
    // The failure is reported, not leaked.
    expect(text).not.toContain('exploded');
  });

  it('carries a truncation note through to the output', async () => {
    // A model shown 5 of 90 unread will describe those 5 as the inbox unless
    // it is told otherwise.
    const tools = toolsOf([
      provider(
        'microsoft',
        'Unread mail',
        section({
          connector: 'microsoft',
          label: 'Unread mail',
          headline: '90 unread',
          omitted: 'showing the 5 most recent of 90 unread',
        })
      ),
    ]);

    const text = textOf(await tools.get('daily_summary')!({}));
    expect(text).toContain('90 unread');
    expect(text).toContain('showing the 5 most recent');
  });

  it('names the sources that had nothing rather than omitting them silently', async () => {
    const tools = toolsOf([
      provider('jira', 'Sprint', section()),
      provider('zoom', 'Zoom notes', null),
    ]);

    const text = textOf(await tools.get('daily_summary')!({}));
    // "Nothing happened in Zoom" and "Zoom was not consulted" are different
    // facts, and a reader deserves to know which.
    expect(text).toContain('Nothing to report from: Zoom notes');
  });

  it('states the window and zone it actually used', async () => {
    const tools = toolsOf([provider('jira', 'Sprint', section())]);
    const text = textOf(
      await tools.get('daily_summary')!({ period: 'yesterday', timeZone: 'Europe/London' })
    );
    expect(text).toContain('yesterday');
    expect(text).toContain('Europe/London');
  });

  it('restricts to the requested connectors', async () => {
    const tools = toolsOf([
      provider('jira', 'Sprint', section()),
      provider('microsoft', 'Calendar', section({ connector: 'microsoft', label: 'Calendar' })),
    ]);

    const text = textOf(await tools.get('daily_summary')!({ only: ['jira'] }));
    expect(text).toContain('Sprint');
    expect(text).not.toContain('Calendar');
  });

  it('says which connectors exist when asked for one that does not', async () => {
    const tools = toolsOf([provider('jira', 'Sprint', section())]);
    const text = textOf(await tools.get('daily_summary')!({ only: ['zoom'] }));
    expect(text).toContain('jira');
  });

  it('registers nothing at all when the caller has no connectors', () => {
    expect(toolsOf([]).size).toBe(0);
  });
});

describe('per-connector summary tools', () => {
  it('exposes one tool per provider alongside the composite', () => {
    const tools = toolsOf([
      provider('jira', 'Sprint', section()),
      provider('microsoft', 'Calendar', section()),
    ]);
    expect([...tools.keys()].sort()).toEqual([
      'daily_summary',
      'jira_summary',
      'microsoft_summary',
    ]);
  });

  it('answers for its own source only', async () => {
    const tools = toolsOf([
      provider('jira', 'Sprint', section()),
      provider(
        'microsoft',
        'Calendar',
        section({ connector: 'microsoft', label: 'Calendar', lines: ['09:00 Standup'] })
      ),
    ]);

    const text = textOf(await tools.get('jira_summary')!({}));
    expect(text).toContain('ENG-1');
    expect(text).not.toContain('Standup');
  });

  it('reports an empty source plainly rather than erroring', async () => {
    const tools = toolsOf([provider('zoom', 'Zoom notes', null)]);
    const result = await tools.get('zoom_summary')!({});
    expect(textOf(result)).toContain('Nothing to report');
    expect('isError' in result).toBe(false);
  });
});
