/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * JSM Operations tools, against a stubbed Ops API.
 *
 * These test one property above all: an id a LATER tool requires must appear
 * in the output of the tool documented as supplying it. That handoff is the
 * only way a model can chain two calls, and it breaks silently — the listing
 * looks complete and helpful, and the failure surfaces one tool later as a
 * 404 from Atlassian that says nothing about which tool dropped the field.
 *
 * That is not hypothetical. jsm_ops_list_schedules printed every rotation's
 * name, type, length and participants, and omitted its id, while
 * jsm_ops_update_rotation required a rotationId and told the caller to get it
 * from jsm_ops_list_schedules. The documented path could not be walked. The
 * only move the listing left was to pass the rotation's NAME as the id, which
 * Atlassian answered with `No schedule rotation exists with id
 * [Business%20Hours]` — an error that reads like the caller's mistake.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));
// withPresentationHint is the only thing ops.ts still imports from ../common
// (auth moved to the injected JsmOpsAuth — see ops-auth.ts) — but merely
// importing ../common transitively pulls in @renkei/db for OTHER exports
// this suite never touches, and @renkei/db imports kysely, which is
// ESM-only and untransformed here. Mocked whole for that reason, not to
// swap any behavior.
jest.mock('../common', () => ({
  withPresentationHint: (text: string) => text,
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerJsmOpsTools } from './ops';
import type { JsmOpsAuth } from './ops-auth';
import type { MCPToolContext } from '../common';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

const mockJiraFetch = jest.fn();

/**
 * A stub `JsmOpsAuth`: unconditionally available, unconditionally in-scope,
 * every call routed to `mockJiraFetch` with just the relative path (no base
 * to reconstruct — these tests never cared which base ops.ts used, only
 * what it asked for). What real auth wrapping looks like — base URL choice,
 * the scope gate, `unavailableReason()` — is ops-auth.test.ts's job, in
 * isolation; this file is only about the tools' own rendering and wizard
 * logic, uninterested in how auth works.
 */
function stubAuth(): JsmOpsAuth {
  return {
    kind: 'oauth',
    unavailableReason: () => null,
    fetch: (_requiredScopes, path, init) => mockJiraFetch(path, init),
  };
}

const context = (): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    cloudId: 'cloud-1',
    accessToken: 'token-1',
    siteUrl: '',
    apiBaseUrl: '',
    maxJqlResults: 100,
  }) as unknown as MCPToolContext;

async function toolsOf(auth: JsmOpsAuth = stubAuth()): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerJsmOpsTools(server, context(), auth);
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** One schedule, two named rotations, shaped like the Ops API's expand=rotation. */
const SCHEDULES = {
  values: [
    {
      id: '999c5b32-383e-4662-939b-2b1cf1923931',
      name: 'Development Team',
      timezone: 'America/Los_Angeles',
      enabled: true,
      teamId: 'team-1',
      rotations: [
        {
          id: 'a1b2c3d4-0000-4000-8000-000000000001',
          name: 'Business Hours',
          type: 'weekly',
          length: 1,
          participants: [
            { type: 'user', id: '712020:40993c07-b113-460b-bf3e-b9651f6d8725' },
            { type: 'user', id: '622be0dc59c0740069dd03b0' },
          ],
        },
        {
          id: 'a1b2c3d4-0000-4000-8000-000000000002',
          name: 'After Hours',
          type: 'daily',
          length: 1,
          participants: [{ type: 'user', id: '622be0dc59c0740069dd03b0' }],
        },
      ],
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockJiraFetch.mockResolvedValue(jsonResponse(SCHEDULES));
});

describe('jsm_ops_list_schedules', () => {
  it('returns the id of every rotation, not just its name', async () => {
    const tools = await toolsOf();

    const text = textOf(await tools.get('jsm_ops_list_schedules')!({}));

    expect(text).toContain('a1b2c3d4-0000-4000-8000-000000000001');
    expect(text).toContain('a1b2c3d4-0000-4000-8000-000000000002');
  });

  it('pairs each rotation id with its own name', async () => {
    // Printing the ids somewhere in the blob is not enough: two rotations on
    // one schedule means the caller has to know WHICH id is Business Hours,
    // and picking the wrong one silently edits the wrong rotation.
    const tools = await toolsOf();

    const text = textOf(await tools.get('jsm_ops_list_schedules')!({}));
    const businessHours = text.split('\n').find((line) => line.includes('Business Hours'));
    const afterHours = text.split('\n').find((line) => line.includes('After Hours'));

    expect(businessHours).toContain('a1b2c3d4-0000-4000-8000-000000000001');
    expect(afterHours).toContain('a1b2c3d4-0000-4000-8000-000000000002');
  });

  it('still returns the schedule id its own consumers need', async () => {
    const tools = await toolsOf();

    const text = textOf(await tools.get('jsm_ops_list_schedules')!({}));

    expect(text).toContain('999c5b32-383e-4662-939b-2b1cf1923931');
  });

  it('keeps participants addressable by account id', async () => {
    // update_rotation takes a REPLACEMENT participant list, so editing one
    // safely means being able to read the current members back first.
    const tools = await toolsOf();

    const text = textOf(await tools.get('jsm_ops_list_schedules')!({}));

    expect(text).toContain('712020:40993c07-b113-460b-bf3e-b9651f6d8725');
    expect(text).toContain('622be0dc59c0740069dd03b0');
  });

  it('asks the API to expand rotations, or there would be none to list', async () => {
    const tools = await toolsOf();
    await tools.get('jsm_ops_list_schedules')!({});

    expect(String(mockJiraFetch.mock.calls[0]?.[0])).toContain('expand=rotation');
  });
});

describe('ops id handoffs', () => {
  it('emits every id another ops tool asks it for', async () => {
    // A guard on the whole class rather than the one instance. Each entry is
    // a promise made in some tool's inputSchema — "id from <this tool>" — and
    // a listing that cannot keep it is unusable in a way no test of that
    // listing alone would notice.
    const cases: { tool: string; body: unknown; expected: string[] }[] = [
      {
        tool: 'jsm_ops_list_schedules',
        body: SCHEDULES,
        // scheduleId → whos_on_call, list_overrides, create_override,
        // update_rotation; rotationId → update_rotation, create_override.
        expected: ['999c5b32-383e-4662-939b-2b1cf1923931', 'a1b2c3d4-0000-4000-8000-000000000001'],
      },
      {
        tool: 'jsm_ops_list_alerts',
        body: { values: [{ id: 'alert-9', message: 'Disk full', status: 'open', priority: 'P1' }] },
        // alertId → get_alert, acknowledge_alert, close_alert.
        expected: ['alert-9'],
      },
      {
        tool: 'jsm_ops_list_teams',
        // `platformTeams`, not `values` — the teams endpoint is the one Ops
        // listing that does not use the common envelope. Writing this fixture
        // wrong is how the test found out.
        body: { platformTeams: [{ teamId: 'team-7', teamName: 'Development Team' }] },
        // teamId → list_escalations.
        expected: ['team-7'],
      },
      {
        tool: 'jsm_ops_list_overrides',
        body: {
          values: [
            {
              alias: 'override-3',
              responder: { type: 'user', id: 'u-1' },
              startDate: '2026-08-14T09:00:00Z',
              endDate: '2026-08-15T09:00:00Z',
            },
          ],
        },
        // alias → delete_override.
        expected: ['override-3'],
      },
    ];

    const tools = await toolsOf();
    for (const { tool, body, expected } of cases) {
      mockJiraFetch.mockResolvedValue(jsonResponse(body));
      const text = textOf(await tools.get(tool)!({ scheduleId: 's-1', teamId: 'team-7' }));
      for (const id of expected) {
        expect(`${tool}: ${text}`).toContain(id);
      }
    }
  });
});
