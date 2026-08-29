/**
 * The card tools' contract: MCP cards are info-kind and owner-scoped;
 * update/dismiss/archive guard entirely in the WHERE clause (zero rows =
 * refusal, whatever the reason); provenance is stamped from the context.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('kysely', () => ({ sql: () => 'sql-fragment' }));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerCardTools } from './index';
import type { MCPToolContext } from '../common';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

function registerAll(context: Partial<MCPToolContext>): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  registerCardTools(server as unknown as McpServer, {
    tenantId: 'tenant-1',
    accountId: 'account-1',
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: 100,
    subject: 'auth0|alice',
    ...context,
  });
  return handlers;
}

interface DbState {
  inserted: Array<Record<string, unknown>>;
  updates: Array<{ sets: Record<string, unknown>; wheres: Array<unknown[]> }>;
  updatedRows: number;
  /** What a card_list select resolves to. */
  rows?: Array<Record<string, unknown>>;
}

function stubDb(state: DbState): void {
  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      insertInto: () => ({
        values: (row: Record<string, unknown>) => ({
          execute: async () => {
            state.inserted.push(row);
            return [];
          },
        }),
      }),
      selectFrom: () => {
        const chain = {
          leftJoin: () => chain,
          select: () => chain,
          where: () => chain,
          orderBy: () => chain,
          limit: () => chain,
          execute: async () => state.rows ?? [],
        };
        return chain;
      },
      updateTable: () => ({
        set: (sets: Record<string, unknown>) => {
          const wheres: Array<unknown[]> = [];
          const chain = {
            where: (...args: unknown[]) => {
              wheres.push(args);
              return chain;
            },
            executeTakeFirst: async () => {
              state.updates.push({ sets, wheres });
              return { numUpdatedRows: BigInt(state.updatedRows) };
            },
          };
          return chain;
        },
      }),
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('card_create stamps owner, kind info, and agent provenance', async () => {
  const state: DbState = { inserted: [], updates: [], updatedRows: 1 };
  stubDb(state);
  const handlers = registerAll({ agent: { agentId: 'agent-9' } });

  const result = await handlers.get('card_create')!({
    title: 'Morning summary',
    summary: 'All quiet.',
  });
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.text).toContain('cardId:');

  expect(state.inserted).toHaveLength(1);
  const row = state.inserted[0]!;
  expect(row.kind).toBe('info');
  expect(row.owner_subject).toBe('auth0|alice');
  expect(row.created_by).toBe('auth0|alice');
  expect(row.created_by_agent_id).toBe('agent-9');
  expect(row.source).toBe('agent');
  expect(row.suggested_action).toBeNull();
});

test('a user call (no agent context) stamps source mcp and no agent id', async () => {
  const state: DbState = { inserted: [], updates: [], updatedRows: 1 };
  stubDb(state);
  const handlers = registerAll({});
  await handlers.get('card_create')!({ title: 'T', summary: 'S' });
  expect(state.inserted[0]!.source).toBe('mcp');
  expect(state.inserted[0]!.created_by_agent_id).toBeNull();
});

test('card_update refuses when the guarded UPDATE matches nothing', async () => {
  const state: DbState = { inserted: [], updates: [], updatedRows: 0 };
  stubDb(state);
  const handlers = registerAll({});
  const result = await handlers.get('card_update')!({ cardId: 'c-1', title: 'New' });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('No updatable card');
  // The guards ride in the WHERE: owner, created_by, status.
  const flat = state.updates[0]!.wheres.map((w) => w.join(' '));
  expect(flat).toEqual(
    expect.arrayContaining([
      'owner_subject = auth0|alice',
      'created_by is not ',
      'status = suggested',
    ])
  );
});

test('card_dismiss records the decision and archives in one stroke', async () => {
  const state: DbState = { inserted: [], updates: [], updatedRows: 1 };
  stubDb(state);
  const handlers = registerAll({});
  const result = await handlers.get('card_dismiss')!({ cardId: 'c-1' });
  expect(result.isError).toBeUndefined();
  const sets = state.updates[0]!.sets;
  expect(sets.status).toBe('dismissed');
  expect(sets.decided_by).toBe('auth0|alice');
  expect(Object.keys(sets)).toEqual(
    expect.arrayContaining(['archived_at', 'archived_by', 'decided_at'])
  );
});

test('card_archive only touches decided, unarchived cards', async () => {
  const state: DbState = { inserted: [], updates: [], updatedRows: 0 };
  stubDb(state);
  const handlers = registerAll({});
  const result = await handlers.get('card_archive')!({ cardId: 'c-1' });
  expect(result.isError).toBe(true);
  const flat = state.updates[0]!.wheres.map((w) => w.map(String).join(' '));
  expect(flat).toEqual(expect.arrayContaining(['status != suggested']));
  expect(flat.some((clause) => clause.startsWith('archived_at is'))).toBe(true);
});

test('every card tool fails closed without a subject', async () => {
  const state: DbState = { inserted: [], updates: [], updatedRows: 1 };
  stubDb(state);
  const handlers = registerAll({ subject: undefined });
  for (const name of ['card_create', 'card_update', 'card_dismiss', 'card_archive', 'card_list']) {
    const result = await handlers.get(name)!({ cardId: 'c', title: 'T', summary: 'S' });
    expect(result.isError).toBe(true);
  }
  expect(state.inserted).toHaveLength(0);
  expect(state.updates).toHaveLength(0);
});

describe('card_list tells an approval apart from a note', () => {
  const base = {
    status: 'suggested',
    created_at: new Date('2026-08-28T09:00:00.000Z'),
    archived_at: null,
  };
  const info = {
    ...base,
    id: 'card-info',
    kind: 'info',
    source: 'mcp',
    title: 'Overnight summary',
    summary: 'Three things happened.',
    runId: null,
    agentId: null,
    agentName: null,
  };
  const approval = {
    ...base,
    id: 'card-approval',
    kind: 'approval',
    source: 'agents',
    title: 'Refund triage — needs your approval',
    summary: 'Refund $240 to Dana Lin?',
    runId: 'run-1',
    agentId: 'agent-1',
    agentName: 'Refund triage',
  };

  it('names the run an approval is holding up, and how to answer it', async () => {
    // Without this a caller reads a paused agent as a note to acknowledge —
    // or leaves it sitting, which comes to the same thing.
    const state: DbState = { inserted: [], updates: [], updatedRows: 1, rows: [approval] };
    stubDb(state);
    const handlers = registerAll({});

    const text = (await handlers.get('card_list')!({})).content[0]?.text ?? '';

    expect(text).toContain('— approval · suggested · from agents');
    expect(text).toContain('Paused run run-1 of agent "Refund triage" (agent-1)');
    expect(text).toContain('decide it with agent_approval_decide');
  });

  it('leaves an info card alone — no run, no decision pointer', async () => {
    const state: DbState = { inserted: [], updates: [], updatedRows: 1, rows: [info] };
    stubDb(state);
    const handlers = registerAll({});

    const text = (await handlers.get('card_list')!({})).content[0]?.text ?? '';

    expect(text).toContain('— info · suggested · from mcp');
    expect(text).not.toContain('Paused run');
    expect(text).not.toContain('agent_approval_decide');
  });

  it('stops offering a decision once the approval is decided', async () => {
    const state: DbState = {
      inserted: [],
      updates: [],
      updatedRows: 1,
      rows: [{ ...approval, status: 'approved', archived_at: new Date() }],
    };
    stubDb(state);
    const handlers = registerAll({});

    const text = (await handlers.get('card_list')!({})).content[0]?.text ?? '';

    // The run context still helps ("which run was that?"); the pointer
    // would only invite a second decision on a card that has one.
    expect(text).toContain('Paused run run-1');
    expect(text).not.toContain('decide it with agent_approval_decide');
  });
});
