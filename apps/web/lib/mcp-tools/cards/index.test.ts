/**
 * The card tools' contract: MCP cards are info-kind and owner-scoped;
 * update/dismiss/archive guard entirely in the one write (zero rows =
 * refusal, whatever the reason); provenance is stamped from the context.
 * Run against a memory data store, so the guards are the store's own.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type TableRows,
} from '@renkei/db';
import { registerCardTools } from './index';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

const ALICE = 'auth0|alice';
const AGENT = '00000000-0000-4000-8000-0000000000a9';
const RUN = '00000000-0000-4000-8000-0000000000f1';
const card = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function registerAll(context: Partial<MCPToolContext>): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  registerCardTools(server as unknown as McpServer, {
    accountId: 'account-1',
    siteUrl: '',
    apiBaseUrl: '',
    jiraAuth: null,
    maxJqlResults: 100,
    subject: ALICE,
    ...context,
  });
  return handlers;
}

function item(n: number, fields: Record<string, unknown> = {}) {
  return {
    id: card(n),
    source: 'mcp',
    kind: 'info',
    status: 'suggested',
    title: `card ${n}`,
    summary: `summary ${n}`,
    evidence: {},
    owner_subject: ALICE,
    created_by: ALICE,
    created_by_agent_id: null,
    suggested_action: null,
    result: null,
    run_id: null,
    step_id: null,
    attempt: null,
    iteration: null,
    decided_at: null,
    decided_by: null,
    archived_at: null,
    archived_by: null,
    created_at: new Date(Date.UTC(2026, 7, 28, 9, n)),
    updated_at: new Date(Date.UTC(2026, 7, 28, 9, n)),
    ...fields,
  };
}

let store: ReturnType<typeof createMemoryDataStore>;

async function seed(rows: NonNullable<TableRows['actionable_items']> = []): Promise<void> {
  store = createMemoryDataStore();
  await store.seed({
    agents: [{ id: AGENT, name: 'Refund triage', owner_subject: ALICE }],
    agent_runs: [
      {
        id: RUN,
        agent_id: AGENT,
        owner_subject: ALICE,
        trigger_kind: 'manual',
        status: 'waiting',
        waiting_until: null,
        cancel_requested_at: null,
        created_at: new Date(Date.UTC(2026, 7, 28, 9)),
        updated_at: new Date(Date.UTC(2026, 7, 28, 9)),
      },
    ],
    actionable_items: rows,
  });
  registerDataStore(store);
}

const read = (n: number) => store.actionableItems.findVisible(ALICE, card(n));
const handle = (handlers: Map<string, Handler>, name: string) => {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`${name} was not registered`);
  return handler;
};

afterAll(() => {
  resetDataStore();
});

test('card_create stamps owner, kind info, and agent provenance', async () => {
  await seed();
  const handlers = registerAll({ agent: { agentId: AGENT } });

  const result = await handle(
    handlers,
    'card_create'
  )({
    title: 'Morning summary',
    summary: 'All quiet.',
  });
  expect(result.isError).toBeUndefined();
  const id = /cardId: (\S+)/.exec(result.content[0]?.text ?? '')?.[1] ?? '';

  const created = await store.actionableItems.findVisible(ALICE, id);
  expect(created).toMatchObject({
    kind: 'info',
    ownerSubject: ALICE,
    agentId: AGENT,
    source: 'agent',
    suggestedAction: null,
    evidence: {},
  });
  // Owned: nobody else sees it.
  expect(await store.actionableItems.findVisible('auth0|bob', id)).toBeNull();
});

test('a user call (no agent context) stamps source mcp and no agent id', async () => {
  await seed();
  const handlers = registerAll({});
  const result = await handle(handlers, 'card_create')({ title: 'T', summary: 'S' });
  const id = /cardId: (\S+)/.exec(result.content[0]?.text ?? '')?.[1] ?? '';
  expect(await store.actionableItems.findVisible(ALICE, id)).toMatchObject({
    source: 'mcp',
    agentId: null,
  });
});

test('card_update changes only an own, MCP-created, undecided card', async () => {
  await seed([
    item(1),
    item(2, { created_by: null }),
    item(3, { status: 'dismissed' }),
    item(4, { owner_subject: 'auth0|bob' }),
  ]);
  const handlers = registerAll({});
  const update = handle(handlers, 'card_update');

  expect((await update({ cardId: card(1), title: 'New' })).isError).toBeUndefined();
  expect((await read(1))?.title).toBe('New');

  for (const n of [2, 3, 4]) {
    const result = await update({ cardId: card(n), title: 'New' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('No updatable card');
  }
  expect((await read(2))?.title).toBe('card 2');
  expect((await read(3))?.title).toBe('card 3');
});

test('card_dismiss records the decision and archives in one stroke', async () => {
  await seed([item(1)]);
  const handlers = registerAll({});
  const result = await handle(handlers, 'card_dismiss')({ cardId: card(1) });
  expect(result.isError).toBeUndefined();
  const dismissed = await read(1);
  expect(dismissed?.status).toBe('dismissed');
  expect(dismissed?.decidedAt).not.toBeNull();
  expect(dismissed?.archivedAt).not.toBeNull();

  // Already decided: a second dismissal is refused.
  expect((await handle(handlers, 'card_dismiss')({ cardId: card(1) })).isError).toBe(true);
});

test('card_archive only touches decided, unarchived cards', async () => {
  await seed([item(1), item(2, { status: 'executed' })]);
  const handlers = registerAll({});
  const archive = handle(handlers, 'card_archive');

  expect((await archive({ cardId: card(1) })).isError).toBe(true);
  expect((await read(1))?.archivedAt).toBeNull();

  expect((await archive({ cardId: card(2) })).isError).toBeUndefined();
  expect((await read(2))?.archivedAt).not.toBeNull();
  expect((await archive({ cardId: card(2) })).isError).toBe(true);
});

test('every card tool fails closed without a subject', async () => {
  await seed([item(1)]);
  const handlers = registerAll({ subject: undefined });
  for (const name of ['card_create', 'card_update', 'card_dismiss', 'card_archive', 'card_list']) {
    const result = await handle(handlers, name)({ cardId: card(1), title: 'T', summary: 'S' });
    expect(result.isError).toBe(true);
  }
  const all = await store.actionableItems.listVisible(ALICE, {
    limit: 10,
    includeArchived: true,
  });
  expect(all.map((row) => [row.id, row.title, row.status])).toEqual([
    [card(1), 'card 1', 'suggested'],
  ]);
});

describe('card_list tells an approval apart from a note', () => {
  const info = item(1, { title: 'Overnight summary', summary: 'Three things happened.' });
  const approval = item(2, {
    kind: 'approval',
    source: 'agents',
    title: 'Refund triage — needs your approval',
    summary: 'Refund $240 to Dana Lin?',
    run_id: RUN,
    created_by_agent_id: AGENT,
    created_by: null,
  });

  it('names the run an approval is holding up, and how to answer it', async () => {
    // Without this a caller reads a paused agent as a note to acknowledge —
    // or leaves it sitting, which comes to the same thing.
    await seed([approval]);
    const text = (await handle(registerAll({}), 'card_list')({})).content[0]?.text ?? '';

    expect(text).toContain('— approval · suggested · from agents');
    expect(text).toContain(`Paused run ${RUN} of agent "Refund triage" (${AGENT})`);
    expect(text).toContain('decide it with agent_approval_decide');
  });

  it('leaves an info card alone — no run, no decision pointer', async () => {
    await seed([info]);
    const text = (await handle(registerAll({}), 'card_list')({})).content[0]?.text ?? '';

    expect(text).toContain('— info · suggested · from mcp');
    expect(text).not.toContain('Paused run');
    expect(text).not.toContain('agent_approval_decide');
  });

  it('stops offering a decision once the approval is decided', async () => {
    await seed([{ ...approval, status: 'approved', archived_at: new Date() }]);
    const text =
      (await handle(registerAll({}), 'card_list')({ includeArchived: true })).content[0]?.text ??
      '';

    // The run context still helps ("which run was that?"); the pointer
    // would only invite a second decision on a card that has one.
    expect(text).toContain(`Paused run ${RUN}`);
    expect(text).not.toContain('decide it with agent_approval_decide');
  });

  it('lists newest first, hides archived cards unless asked, and filters by status', async () => {
    await seed([
      info,
      approval,
      item(3, { status: 'executed', archived_at: new Date() }),
      item(4, { owner_subject: 'auth0|bob', title: 'not mine' }),
    ]);
    const list = handle(registerAll({}), 'card_list');
    const ids = async (args: Record<string, unknown>) =>
      [...((await list(args)).content[0]?.text ?? '').matchAll(/cardId: (\S+)/g)].map(
        (match) => match[1]
      );

    expect(await ids({})).toEqual([card(2), card(1)]);
    expect(await ids({ includeArchived: true })).toEqual([card(3), card(2), card(1)]);
    expect(await ids({ status: 'executed', includeArchived: true })).toEqual([card(3)]);
  });
});
