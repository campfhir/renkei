/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * JSM Operations rotation ids, against a REAL Atlassian sandbox.
 *
 * This is the regression test for a specific reported failure, not a
 * general Ops smoke test. `jsm_ops_list_schedules` printed every rotation's
 * name, type, length and participants — and never its id — while
 * `jsm_ops_update_rotation` requires a rotationId and its own schema says to
 * get one from `jsm_ops_list_schedules`. The documented handoff could not be
 * walked. The only move available was to pass the rotation's NAME as the
 * id, which Atlassian answered with `No schedule rotation exists with id
 * [Business%20Hours]` — a 404 that reads like the caller's mistake, not the
 * tool's.
 *
 * ops.test.ts already covers this with a stubbed auth and proves the
 * rendering is correct. This file proves something a stub cannot: that the
 * REAL Ops API returns `rotation.id` in the shape the fix expects, and that
 * the id it hands back is actually accepted downstream — by
 * `jsm_ops_update_rotation` AND `jsm_ops_create_override`, the two tools
 * whose schemas point back at this one.
 *
 * The only thing this file does differently from production is which
 * `JsmOpsAuth` it hands `registerJsmOpsTools` — `patJsmOpsAuth` here, where
 * index.ts injects `oauthJsmOpsAuth`. ops.ts itself is untouched: no mock of
 * `../common`, no swapped fetch, no URL rewriting. That is the point of
 * ops-auth.ts existing — a bug in argument handling or response shaping
 * fails here exactly as it would in production, because the code running
 * IS production's code.
 *
 * Needs TEST_JIRA_USER_NAME, TEST_JIRA_API_TOKEN and
 * TEST_JIRA_SANDBOX_API_BASE_URL in .env.development; run with
 * `pnpm test:integration`. Skips itself, rather than failing, when those are
 * absent — `pnpm test` never depends on this file.
 *
 * The suite creates one disposable schedule (with a rotation, so there is a
 * real rotationId to chase through the fix) and deletes it in afterAll.
 * Nothing here reads or writes anyone's actual on-call configuration —
 * JSM Operations is not part of Atlassian's site-copy, so the sandbox
 * carries no Ops data of its own to disturb even by accident.
 */

// ops.ts imports withPresentationHint from ../common, which transitively
// imports @renkei/db for OTHER exports this file never touches — and
// @renkei/db imports kysely, which ships ESM-only and jest's CJS runtime
// cannot parse. This is the same guard sharepoint.test.ts uses: a stub
// narrow enough to let the real module graph finish loading, not a mock of
// any behavior this suite cares about (unlike the old version of this file,
// which mocked ../common itself to swap the auth transport — that need is
// gone now that auth is injected; see ops-auth.ts).
jest.mock('kysely', () => ({ sql: () => ({}) }));

import type { McpServer } from '@modelcontextprotocol/server';
import { registerJsmOpsTools } from './ops';
import type { JsmOpsAuth } from './ops-auth';
import type { MCPToolContext } from '../common';
import {
  sandboxCredentials,
  resolveCloudId,
  resolveOwnAccountId,
  patJsmOpsAuth,
  type SandboxCredentials,
} from '../test-support/atlassian-sandbox';

jest.setTimeout(30_000);

const creds = sandboxCredentials();

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { text: string }[];
  isError?: boolean;
}>;

async function toolsOf(context: MCPToolContext, auth: JsmOpsAuth): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  await registerJsmOpsTools(server, context, auth);
  return registered;
}

const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? '';

/**
 * Fixture setup/teardown, through the SAME `auth.fetch` the tools under test
 * use — no separate base URL or auth header to keep in sync with
 * patJsmOpsAuth's. There is no registered tool for creating a schedule, so
 * this goes around ops.ts, not around the auth.
 */
async function createFixtureSchedule(
  auth: JsmOpsAuth,
  participantAccountId: string
): Promise<{ scheduleId: string; rotationId: string }> {
  const response = await auth.fetch([], '/schedules', {
    method: 'POST',
    body: JSON.stringify({
      name: `renkei-integration-test-${Date.now()}`,
      timezone: 'UTC',
      rotations: [
        {
          name: 'renkei-integration-test-rotation',
          type: 'weekly',
          length: 1,
          startDate: new Date().toISOString(),
          participants: [{ type: 'user', id: participantAccountId }],
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Could not create the fixture schedule: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { id: string; rotations: { id: string }[] };
  const rotationId = body.rotations[0]?.id;
  if (!body.id || !rotationId) {
    throw new Error(`Fixture schedule response carried no id: ${JSON.stringify(body)}`);
  }
  return { scheduleId: body.id, rotationId };
}

async function deleteFixtureSchedule(auth: JsmOpsAuth, scheduleId: string): Promise<void> {
  const response = await auth.fetch([], `/schedules/${scheduleId}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Could not delete fixture schedule ${scheduleId}: HTTP ${response.status}. ` +
        'It is left behind in the sandbox — remove it manually.'
    );
  }
}

async function fetchRotation(
  auth: JsmOpsAuth,
  scheduleId: string,
  rotationId: string
): Promise<{ name: string }> {
  const response = await auth.fetch([], `/schedules/${scheduleId}/rotations/${rotationId}`);
  if (!response.ok) {
    throw new Error(`Could not read fixture rotation: HTTP ${response.status}`);
  }
  return response.json() as Promise<{ name: string }>;
}

// Named so a skip shows WHY in test output, not just that it happened.
const SUITE_NAME = creds
  ? 'JSM Ops rotation ids (sandbox integration)'
  : 'JSM Ops rotation ids (sandbox integration) — SKIPPED: set TEST_JIRA_USER_NAME, ' +
    'TEST_JIRA_API_TOKEN and TEST_JIRA_SANDBOX_API_BASE_URL in .env.development';
const describeOrSkip = creds ? describe : describe.skip;

describeOrSkip(SUITE_NAME, () => {
  let auth: JsmOpsAuth;
  let myAccountId: string;
  let scheduleId: string;
  let rotationId: string;
  let tools: Map<string, Handler>;

  beforeAll(async () => {
    // Guarded by describeOrSkip above; asserting narrows the type for
    // everything below rather than repeating `creds!` at every call site.
    if (!creds) throw new Error('unreachable — suite should have skipped');
    const testCreds: SandboxCredentials = creds;
    const cloudId = await resolveCloudId(testCreds);
    myAccountId = await resolveOwnAccountId(testCreds);
    auth = patJsmOpsAuth(testCreds, cloudId);

    const fixture = await createFixtureSchedule(auth, myAccountId);
    scheduleId = fixture.scheduleId;
    rotationId = fixture.rotationId;

    // tenantId/accountId are log context only — auth carries everything
    // HTTP-related, so this context never needs an accessToken or cloudId.
    const context = {
      tenantId: 'integration-test',
      accountId: 'integration-test',
      siteUrl: '',
      apiBaseUrl: '',
      accessToken: '',
      maxJqlResults: 100,
    } as unknown as MCPToolContext;
    tools = await toolsOf(context, auth);
  });

  afterAll(async () => {
    if (!auth || !scheduleId) return;
    await deleteFixtureSchedule(auth, scheduleId);
  });

  describe('jsm_ops_list_schedules', () => {
    it('returns the id of the rotation it just created', async () => {
      const text = textOf(await tools.get('jsm_ops_list_schedules')!({}));

      expect(text).toContain('renkei-integration-test-rotation');
      expect(text).toContain(rotationId);
    });

    it('does not require guessing the id from the name', async () => {
      // The exact failure mode reported: the id has to be IN the output,
      // addressable by something other than reading it back off a name.
      const text = textOf(await tools.get('jsm_ops_list_schedules')!({}));
      const rotationLine = text
        .split('\n')
        .find((line) => line.includes('renkei-integration-test-rotation'));

      expect(rotationLine).toBeDefined();
      expect(rotationLine).toContain(`id: ${rotationId}`);
    });
  });

  describe('jsm_ops_update_rotation — the tool this id feeds', () => {
    it('accepts the id list_schedules returned, where a name 404s', async () => {
      // Reproduces the bug's exact dead end, from the other side: this same
      // call with the rotation's NAME in place of rotationId is what
      // produced "No schedule rotation exists with id [Business%20Hours]".
      const result = await tools.get('jsm_ops_update_rotation')!({ scheduleId, rotationId });

      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('No changes given');
      expect(textOf(result)).toContain(myAccountId);
    });

    it('previews a change without writing it', async () => {
      const result = await tools.get('jsm_ops_update_rotation')!({
        scheduleId,
        rotationId,
        name: 'renamed-by-integration-test',
      });

      expect(textOf(result)).toContain('PREVIEW');
      expect(textOf(result)).toContain('nothing written yet');

      const stillOriginal = await fetchRotation(auth, scheduleId, rotationId);
      expect(stillOriginal.name).toBe('renkei-integration-test-rotation');
    });

    it('writes only after confirm: true, and the write actually lands', async () => {
      const result = await tools.get('jsm_ops_update_rotation')!({
        scheduleId,
        rotationId,
        name: 'renamed-by-integration-test',
        confirm: true,
      });

      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('Rotation updated');

      const renamed = await fetchRotation(auth, scheduleId, rotationId);
      expect(renamed.name).toBe('renamed-by-integration-test');
    });
  });

  describe('jsm_ops_create_override — the other tool this id feeds', () => {
    let alias: string | null = null;

    afterEach(async () => {
      // Best-effort: an override left behind here dies with the fixture
      // schedule in the suite's own afterAll regardless.
      if (alias) {
        await tools.get('jsm_ops_delete_override')!({ scheduleId, alias, confirm: true });
        alias = null;
      }
    });

    it('accepts rotationIds containing the id list_schedules returned', async () => {
      const start = new Date(Date.now() + 60_000).toISOString();
      const end = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

      const result = await tools.get('jsm_ops_create_override')!({
        scheduleId,
        responderAccountId: myAccountId,
        startDate: start,
        endDate: end,
        rotationIds: [rotationId],
        confirm: true,
      });

      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain('Override created');

      const overrides = textOf(await tools.get('jsm_ops_list_overrides')!({ scheduleId }));
      expect(overrides).toContain(rotationId);
      const match = /alias: (\S+)/.exec(overrides);
      alias = match?.[1] ?? null;
    });
  });
});
