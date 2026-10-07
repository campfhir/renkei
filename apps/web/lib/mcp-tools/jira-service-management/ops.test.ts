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
 * A stub `JsmOpsAuth`: unconditionally in-scope, every call routed to
 * `mockJiraFetch` with just the relative path (no base to reconstruct —
 * these tests never cared which base ops.ts used, only what it asked for).
 * What real auth wrapping looks like — base URL choice, the scope gate — is
 * ops-auth.test.ts's job, in isolation; this file is only about the tools'
 * own rendering and wizard logic, uninterested in how auth works.
 */
function stubAuth(): JsmOpsAuth {
  return {
    kind: 'oauth',
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

/**
 * Maintenance windows — "put these alert sources in maintenance mode for a
 * while". The tools below drive a four-step wizard against the Ops API's
 * /maintenances (and /teams/{id}/maintenances) endpoints; what is tested is
 * the shape of each step, the request body the final step sends, and that
 * the id handoffs the schemas promise are kept.
 */
describe('maintenance windows', () => {
  const INTEGRATIONS = {
    values: [
      {
        id: '51e9e162-767b-47a6-a00a-4cd8b6f94829',
        name: 'Datadog',
        type: 'Datadog',
        enabled: true,
        teamId: 'team-7',
      },
      { id: '22334455-1288-414d-b0cc-e725ba3331f7', name: 'Email', type: 'Email', enabled: false },
    ],
  };
  const MAINTENANCE = {
    id: '0762db96-f795-4246-90be-edd295af8fca',
    status: 'planned',
    description: 'Database upgrade',
    startDate: '2026-10-08T01:00:00.000Z',
    endDate: '2026-10-08T03:00:00.000Z',
    rules: [
      {
        state: 'disabled',
        entity: { id: '51e9e162-767b-47a6-a00a-4cd8b6f94829', type: 'integration' },
      },
    ],
  };
  const future = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

  it('lists integrations with the id a maintenance rule is built from', async () => {
    mockJiraFetch.mockResolvedValue(jsonResponse(INTEGRATIONS));
    const tools = await toolsOf();

    const text = textOf(await tools.get('jsm_ops_list_integrations')!({ teamId: 'team-7' }));

    const datadog = text.split('\n').find((line) => line.includes('Datadog'));
    expect(datadog).toContain('51e9e162-767b-47a6-a00a-4cd8b6f94829');
    expect(datadog).toContain('enabled');
    expect(text.split('\n').find((line) => line.includes('Email'))).toContain('disabled');
    expect(String(mockJiraFetch.mock.calls[0]?.[0])).toContain('teamId=team-7');
  });

  it('lists planned and active windows by default, with the id cancel needs', async () => {
    mockJiraFetch.mockResolvedValue(jsonResponse({ values: [MAINTENANCE] }));
    const tools = await toolsOf();

    const text = textOf(await tools.get('jsm_ops_list_maintenances')!({}));

    expect(String(mockJiraFetch.mock.calls[0]?.[0])).toBe('/maintenances?type=non-expired&size=20');
    expect(text).toContain('Database upgrade');
    expect(text).toContain('planned');
    expect(text).toContain('integrations: 51e9e162-767b-47a6-a00a-4cd8b6f94829');
    expect(text).toContain('id: 0762db96-f795-4246-90be-edd295af8fca');
  });

  it('lists a team’s own windows under the team path when asked', async () => {
    mockJiraFetch.mockResolvedValue(jsonResponse({ values: [] }));
    const tools = await toolsOf();

    const text = textOf(
      await tools.get('jsm_ops_list_maintenances')!({ teamId: 'team-7', type: 'all' })
    );

    expect(String(mockJiraFetch.mock.calls[0]?.[0])).toBe(
      '/teams/team-7/maintenances?type=all&size=20'
    );
    expect(text).toBe('No maintenances.');
  });

  describe('jsm_ops_create_maintenance', () => {
    it('names every missing piece instead of guessing, and writes nothing', async () => {
      const tools = await toolsOf();

      const text = textOf(await tools.get('jsm_ops_create_maintenance')!({}));

      expect(text).toContain('still needed');
      expect(text).toContain('WHAT');
      expect(text).toContain('WHEN it starts');
      expect(text).toContain('WHEN it ends');
      expect(text).toContain('WHICH integrations');
      expect(mockJiraFetch).not.toHaveBeenCalled();
    });

    it('refuses a window that ends before it starts, or has already ended', async () => {
      const tools = await toolsOf();
      const base = {
        description: 'Database upgrade',
        integrationIds: ['51e9e162-767b-47a6-a00a-4cd8b6f94829'],
      };

      const backwards = await tools.get('jsm_ops_create_maintenance')!({
        ...base,
        startDate: future(2),
        endDate: future(1),
      });
      expect(backwards.isError).toBe(true);
      expect(textOf(backwards)).toContain('end after start');

      const over = await tools.get('jsm_ops_create_maintenance')!({
        ...base,
        startDate: '2020-01-01T00:00:00Z',
        endDate: '2020-01-01T01:00:00Z',
      });
      expect(over.isError).toBe(true);
      expect(textOf(over)).toContain('already in the past');
      expect(mockJiraFetch).not.toHaveBeenCalled();
    });

    it('previews with integration NAMES, not just ids, and still writes nothing', async () => {
      mockJiraFetch.mockResolvedValue(jsonResponse(INTEGRATIONS.values[0]));
      const tools = await toolsOf();

      const text = textOf(
        await tools.get('jsm_ops_create_maintenance')!({
          description: 'Database upgrade',
          startDate: future(1),
          endDate: future(3),
          integrationIds: ['51e9e162-767b-47a6-a00a-4cd8b6f94829'],
        })
      );

      expect(text).toContain('PREVIEW');
      expect(text).toContain('Datadog (51e9e162-767b-47a6-a00a-4cd8b6f94829)');
      expect(text).toContain('confirm: true');
      // One GET per integration for the name — no POST.
      expect(mockJiraFetch).toHaveBeenCalledTimes(1);
      expect(mockJiraFetch.mock.calls[0]?.[0]).toBe(
        '/integrations/51e9e162-767b-47a6-a00a-4cd8b6f94829'
      );
      expect(mockJiraFetch.mock.calls[0]?.[1]).toBeUndefined();
    });

    it('stops on an integration id that does not resolve', async () => {
      mockJiraFetch.mockResolvedValue(
        new Response('{"message":"no such integration"}', { status: 404 })
      );
      const tools = await toolsOf();

      const result = await tools.get('jsm_ops_create_maintenance')!({
        description: 'Database upgrade',
        startDate: future(1),
        endDate: future(3),
        integrationIds: ['not-an-id'],
        confirm: true,
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('not-an-id');
      expect(mockJiraFetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    });

    it('on confirm, POSTs one disabled rule per integration and policy', async () => {
      mockJiraFetch.mockImplementation((path: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === 'POST'
            ? jsonResponse(MAINTENANCE)
            : jsonResponse(
                path.includes('51e9e162') ? INTEGRATIONS.values[0] : INTEGRATIONS.values[1]
              )
        )
      );
      const tools = await toolsOf();
      const startDate = future(1);
      const endDate = future(3);

      const text = textOf(
        await tools.get('jsm_ops_create_maintenance')!({
          description: 'Database upgrade',
          startDate,
          endDate,
          integrationIds: [
            '51e9e162-767b-47a6-a00a-4cd8b6f94829',
            '22334455-1288-414d-b0cc-e725ba3331f7',
          ],
          policyIds: ['policy-1'],
          teamId: 'team-7',
          confirm: true,
        })
      );

      const post = mockJiraFetch.mock.calls.find(([, init]) => init?.method === 'POST');
      expect(post?.[0]).toBe('/teams/team-7/maintenances');
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({
        description: 'Database upgrade',
        startDate: new Date(startDate).toISOString(),
        endDate: new Date(endDate).toISOString(),
        rules: [
          {
            entity: { id: '51e9e162-767b-47a6-a00a-4cd8b6f94829', type: 'integration' },
            state: 'disabled',
          },
          {
            entity: { id: '22334455-1288-414d-b0cc-e725ba3331f7', type: 'integration' },
            state: 'disabled',
          },
          { entity: { id: 'policy-1', type: 'policy' }, state: 'disabled' },
        ],
      });
      expect(text).toContain('created');
      expect(text).toContain('0762db96-f795-4246-90be-edd295af8fca');
    });
  });

  describe('jsm_ops_cancel_maintenance', () => {
    it('previews the real window and does not cancel without confirm', async () => {
      mockJiraFetch.mockResolvedValue(jsonResponse({ ...MAINTENANCE, status: 'active' }));
      const tools = await toolsOf();

      const text = textOf(
        await tools.get('jsm_ops_cancel_maintenance')!({ maintenanceId: MAINTENANCE.id })
      );

      expect(text).toContain('PREVIEW');
      expect(text).toContain('Database upgrade');
      expect(text).toContain('immediately');
      expect(mockJiraFetch).toHaveBeenCalledTimes(1);
      expect(mockJiraFetch.mock.calls[0]?.[0]).toBe(`/maintenances/${MAINTENANCE.id}`);
    });

    it('says so instead of cancelling a window that is already over', async () => {
      mockJiraFetch.mockResolvedValue(jsonResponse({ ...MAINTENANCE, status: 'past' }));
      const tools = await toolsOf();

      const text = textOf(
        await tools.get('jsm_ops_cancel_maintenance')!({
          maintenanceId: MAINTENANCE.id,
          confirm: true,
        })
      );

      expect(text).toContain('already past');
      expect(mockJiraFetch).toHaveBeenCalledTimes(1);
    });

    it('on confirm, POSTs to /cancel under the team path when a teamId is given', async () => {
      mockJiraFetch.mockResolvedValue(jsonResponse(MAINTENANCE));
      const tools = await toolsOf();

      const text = textOf(
        await tools.get('jsm_ops_cancel_maintenance')!({
          maintenanceId: MAINTENANCE.id,
          teamId: 'team-7',
          confirm: true,
        })
      );

      expect(mockJiraFetch.mock.calls[1]?.[0]).toBe(
        `/teams/team-7/maintenances/${MAINTENANCE.id}/cancel`
      );
      expect(mockJiraFetch.mock.calls[1]?.[1]?.method).toBe('POST');
      expect(text).toContain('cancelled');
    });
  });
});
