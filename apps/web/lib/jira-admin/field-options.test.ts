/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Field option changes: the rulebook planning and applying share, and the
 * executor against a fake Jira. What matters most is what apply does when
 * Jira moved since the proposal — it stops at the first operation that no
 * longer holds, runs nothing after it, and says which ran.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
jest.mock('@renkei/db', () => ({ getDatabase: () => ({ ok: false }) }));
jest.mock('@renkei/crypto', () => ({ parseEncryptionKey: () => ({ ok: false }) }));
jest.mock('@renkei/provider-grants', () => ({}));
jest.mock('@/lib/atlassian-app', () => ({ getAtlassianAdminApp: jest.fn() }));

import type { JiraAdminAccess } from '@/lib/mcp-tools/jira-admin/client';
import {
  applyFieldOptions,
  checkOperation,
  describeOperation,
  describeReach,
  planOptionOperations,
  readFieldOptionsPayload,
  titleFor,
  type FieldOptionsPayload,
  type LiveOption,
  type OptionOperation,
} from './field-options';

const option = (id: string, value: string, disabled = false): LiveOption => ({
  id,
  value,
  disabled,
  parentId: null,
});

const LEVEL: LiveOption[] = [
  option('1', 'Customer'),
  option('2', 'Partner'),
  option('3', 'Legacy', true),
  option('4', 'Internal'),
];

function plan(input: Parameters<typeof planOptionOperations>[0], level = LEVEL) {
  const result = planOptionOperations(input, level);
  if (!result.ok) throw new Error(`expected a plan, got: ${result.reason}`);
  return result.operations;
}

function refusal(input: Parameters<typeof planOptionOperations>[0], level = LEVEL): string {
  const result = planOptionOperations(input, level);
  if (result.ok) throw new Error('expected a refusal');
  return result.reason;
}

describe('planning', () => {
  it('resolves values to option ids, in the fixed order add → rename → enable → disable → move', () => {
    const operations = plan({
      move: { options: ['Vendor', 'Customer'] },
      disable: ['internal'],
      enable: ['Legacy'],
      rename: [{ from: 'Partner', to: 'Channel partner' }],
      add: [' Vendor '],
    });
    expect(operations).toEqual([
      { op: 'add', values: ['Vendor'] },
      { op: 'rename', renames: [{ optionId: '2', from: 'Partner', to: 'Channel partner' }] },
      { op: 'enable', options: [{ optionId: '3', value: 'Legacy' }] },
      { op: 'disable', options: [{ optionId: '4', value: 'Internal' }] },
      // An option this request adds has no id yet, so the move names it by value.
      {
        op: 'move',
        options: [{ value: 'Vendor' }, { id: '1', value: 'Customer' }],
        position: 'First',
      },
    ]);
  });

  it('refuses an option that already exists, and says when enabling is the fix', () => {
    expect(refusal({ add: ['customer'] })).toBe('“Customer” already exists.');
    expect(refusal({ add: ['Legacy'] })).toMatch(/disabled — enable it instead/);
    expect(refusal({ add: ['Vendor', 'vendor'] })).toMatch(/in add twice/);
  });

  it('names close matches when an option does not exist', () => {
    expect(refusal({ disable: ['Partners'] })).toBe('There is no option “Partners” here.');
    expect(refusal({ disable: ['Part'] })).toBe(
      'There is no option “Part” here. Did you mean “Partner”?'
    );
  });

  it('allows one change per option per request', () => {
    expect(
      refusal({ rename: [{ from: 'Partner', to: 'Reseller' }], disable: ['Partner'] })
    ).toMatch(/both renamed and disabled/);
  });

  it('refuses a rename onto a name another option has, but allows a change of case', () => {
    expect(refusal({ rename: [{ from: 'Partner', to: 'customer' }] })).toMatch(
      /An option named “Customer” already exists/
    );
    expect(plan({ rename: [{ from: 'Partner', to: 'PARTNER' }] })).toEqual([
      { op: 'rename', renames: [{ optionId: '2', from: 'Partner', to: 'PARTNER' }] },
    ]);
  });

  it('refuses enabling an enabled option and disabling a disabled one', () => {
    expect(refusal({ enable: ['Customer'] })).toBe('“Customer” is already enabled.');
    expect(refusal({ disable: ['Legacy'] })).toBe('“Legacy” is already disabled.');
  });

  it('sorts A–Z across what the same request adds and renames', () => {
    const operations = plan({ add: ['Alpha'], sortAlphabetically: true });
    expect(operations[1]).toEqual({
      op: 'move',
      position: 'First',
      options: [
        { value: 'Alpha' },
        { id: '1', value: 'Customer' },
        { id: '4', value: 'Internal' },
        { id: '3', value: 'Legacy' },
        { id: '2', value: 'Partner' },
      ],
    });
  });

  it('says so when a sort would change nothing', () => {
    const sorted = [option('1', 'A'), option('2', 'B')];
    expect(refusal({ sortAlphabetically: true }, sorted)).toMatch(/already in alphabetical order/);
    // Alongside a real change, the no-op sort is simply dropped.
    expect(plan({ add: ['C'], sortAlphabetically: true }, sorted)).toEqual([
      { op: 'add', values: ['C'] },
    ]);
  });

  it('refuses an empty request, a move with a sort, and a value past Jira’s limit', () => {
    expect(refusal({})).toMatch(/Nothing to change/);
    expect(refusal({ move: { options: ['Customer'] }, sortAlphabetically: true })).toMatch(
      /not both/
    );
    expect(refusal({ add: ['x'.repeat(256)] })).toMatch(/longer than Jira’s 255 characters/);
  });
});

describe('the rulebook at apply time', () => {
  const rename: OptionOperation = {
    op: 'rename',
    renames: [{ optionId: '2', from: 'Partner', to: 'Channel partner' }],
  };

  it('stops a rename whose option was renamed by hand since', () => {
    const moved = LEVEL.map((o) => (o.id === '2' ? { ...o, value: 'Reseller' } : o));
    expect(checkOperation(rename, moved)).toEqual({
      ok: false,
      reason: '“Partner” has been renamed to “Reseller” since this was proposed.',
    });
  });

  it('stops an operation whose option is gone', () => {
    expect(
      checkOperation({ op: 'disable', options: [{ optionId: '9', value: 'Gone' }] }, LEVEL)
    ).toEqual({ ok: false, reason: 'The option “Gone” no longer exists.' });
  });
});

describe('describing', () => {
  const payload: FieldOptionsPayload = {
    field: { id: 'customfield_10100', name: 'Source', type: 'select list (single choice)' },
    context: { id: '10200', name: 'Ops context', global: false, spaces: ['OPS'] },
    parent: null,
    operations: [
      { op: 'add', values: ['Vendor', 'Reseller'] },
      { op: 'disable', options: [{ optionId: '3', value: 'Legacy' }] },
    ],
  };

  it('puts each operation and where it lands in plain words', () => {
    expect(payload.operations.map(describeOperation)).toEqual([
      'Add 2 options: “Vendor”, “Reseller”',
      'Disable “Legacy”',
    ]);
    expect(titleFor(payload)).toBe(
      'Source (Ops context): add 2 options: “Vendor”, “Reseller”; disable “Legacy”'
    );
    expect(describeReach(payload)).toBe('The context “Ops context”, used by OPS.');
    expect(
      describeReach({ ...payload, context: { ...payload.context, global: true, spaces: [] } })
    ).toMatch(/every space that has no context of its own/);
  });

  it('reads back only a payload it wrote in full', () => {
    expect(readFieldOptionsPayload(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
    expect(readFieldOptionsPayload({ ...payload, operations: [] })).toBeNull();
    expect(
      readFieldOptionsPayload({ ...payload, operations: [{ op: 'delete', options: [] }] })
    ).toBeNull();
    expect(readFieldOptionsPayload(null)).toBeNull();
  });
});

describe('applying against Jira', () => {
  const BASE = 'https://api.atlassian.com/ex/jira/cloud-1';
  const OPTIONS = '/rest/api/3/field/customfield_10100/context/10200/option';
  const access: JiraAdminAccess = {
    cloudId: 'cloud-1',
    siteUrl: 'https://acme.atlassian.net',
    accountId: 'acct-1',
    authHeader: 'Bearer t',
  };
  const scope = { tenantId: 'tenant-1', subject: 'subject-1' };

  let live: Record<string, unknown>[];
  let calls: { method: string; path: string; body: unknown }[];
  let failOn: string | null;

  beforeEach(() => {
    live = [
      { id: '1', value: 'Customer', disabled: false },
      { id: '2', value: 'Partner', disabled: false },
      { id: '3', value: 'Legacy', disabled: false },
    ];
    calls = [];
    failOn = null;
    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input).slice(BASE.length);
      const method = init?.method ?? 'GET';
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      if (failOn === `${method} ${path.split('?')[0]}`) {
        return new Response(JSON.stringify({ errorMessages: ['Jira said no.'] }), { status: 400 });
      }
      if (method === 'GET') {
        return new Response(JSON.stringify({ isLast: true, values: live }), { status: 200 });
      }
      if (method === 'POST') {
        const created = ((body as { options: { value: string }[] }).options ?? []).map(
          (o, index) => ({ id: `10${index}`, value: o.value, disabled: false })
        );
        return new Response(JSON.stringify({ options: created }), { status: 200 });
      }
      if (path.endsWith('/move')) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ options: [] }), { status: 200 });
    }) as unknown as typeof fetch;
  });

  const payloadOf = (operations: OptionOperation[]): FieldOptionsPayload => ({
    field: { id: 'customfield_10100', name: 'Source', type: 'select' },
    context: { id: '10200', name: 'Ops context', global: false, spaces: ['OPS'] },
    parent: null,
    operations,
  });

  it('runs each operation once, and moves an option it just added by its new id', async () => {
    const outcome = await applyFieldOptions(
      scope,
      access,
      payloadOf([
        { op: 'add', values: ['Vendor'] },
        { op: 'disable', options: [{ optionId: '3', value: 'Legacy' }] },
        { op: 'move', options: [{ value: 'Vendor' }], position: 'First' },
      ])
    );

    expect(outcome.status).toBe('applied');
    expect(outcome.results.map((r) => r.outcome)).toEqual(['done', 'done', 'done']);
    expect(calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual([
      `GET ${OPTIONS}`,
      `POST ${OPTIONS}`,
      `PUT ${OPTIONS}`,
      `PUT ${OPTIONS}/move`,
    ]);
    expect(calls[1]?.body).toEqual({ options: [{ value: 'Vendor' }] });
    expect(calls[2]?.body).toEqual({ options: [{ id: '3', disabled: true }] });
    expect(calls[3]?.body).toEqual({ customFieldOptionIds: ['100'], position: 'First' });
  });

  it('stops at an operation Jira moved underneath, and runs nothing after it', async () => {
    // Someone added Vendor by hand after the proposal.
    live.push({ id: '9', value: 'Vendor', disabled: false });
    const outcome = await applyFieldOptions(
      scope,
      access,
      payloadOf([
        { op: 'disable', options: [{ optionId: '3', value: 'Legacy' }] },
        { op: 'add', values: ['Vendor'] },
        { op: 'rename', renames: [{ optionId: '2', from: 'Partner', to: 'Reseller' }] },
      ])
    );

    expect(outcome.status).toBe('partial');
    expect(outcome.results).toEqual([
      { label: 'Disable “Legacy”', outcome: 'done' },
      { label: 'Add option “Vendor”', outcome: 'failed', detail: '“Vendor” already exists.' },
      { label: 'Rename “Partner” to “Reseller”', outcome: 'not_run' },
    ]);
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(1);
  });

  it('reports Jira’s own refusal and runs nothing after it', async () => {
    failOn = `POST ${OPTIONS}`;
    const outcome = await applyFieldOptions(
      scope,
      access,
      payloadOf([
        { op: 'add', values: ['Vendor'] },
        { op: 'disable', options: [{ optionId: '3', value: 'Legacy' }] },
      ])
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.results[0]).toEqual({
      label: 'Add option “Vendor”',
      outcome: 'failed',
      detail: 'Jira answered 400. Jira said no.',
    });
    expect(outcome.results[1]?.outcome).toBe('not_run');
  });

  it('treats an option already in its target state as done, without calling Jira for it', async () => {
    live[2] = { id: '3', value: 'Legacy', disabled: true };
    const outcome = await applyFieldOptions(
      scope,
      access,
      payloadOf([{ op: 'disable', options: [{ optionId: '3', value: 'Legacy' }] }])
    );
    expect(outcome).toEqual({
      status: 'applied',
      results: [{ label: 'Disable “Legacy”', outcome: 'done', detail: '1 already disabled.' }],
    });
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('refuses to run under a cascading parent that was renamed since', async () => {
    live.push({ id: '20', value: 'EMEA', disabled: false, optionId: '1' });
    const outcome = await applyFieldOptions(scope, access, {
      ...payloadOf([{ op: 'add', values: ['France'] }]),
      parent: { id: '1', value: 'Europe' },
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.results[0]?.detail).toBe(
      'The parent option “Europe” has been renamed to “Customer” since this was proposed.'
    );
  });

  it('adds cascading children under their parent', async () => {
    const outcome = await applyFieldOptions(scope, access, {
      ...payloadOf([{ op: 'add', values: ['France'] }]),
      parent: { id: '1', value: 'Customer' },
    });
    expect(outcome.status).toBe('applied');
    expect(calls[1]?.body).toEqual({ options: [{ value: 'France', optionId: '1' }] });
  });

  it('fails every operation cleanly when the options cannot be read', async () => {
    failOn = `GET ${OPTIONS}`;
    const outcome = await applyFieldOptions(
      scope,
      access,
      payloadOf([
        { op: 'add', values: ['Vendor'] },
        { op: 'disable', options: [{ optionId: '3', value: 'Legacy' }] },
      ])
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.results.map((r) => r.outcome)).toEqual(['failed', 'not_run']);
    expect(outcome.results[0]?.detail).toMatch(/Could not read the field’s current options/);
  });
});
