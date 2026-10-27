/**
 * Remote MCP servers, end to end against a stand-in server (mcp-stub.mjs)
 * with its own OAuth — through the real web app and the delegate the
 * memory server runs in-process; nothing in between is mocked.
 *
 *   1. an admin lists a server on /admin/mcp, with the context that helps
 *      people and the model find it, and "Check" runs discovery;
 *   2. a person connects it from the Connectors page: the delegate
 *      discovers the authorization server, registers Renkei there
 *      (dynamic registration), the browser signs in at the server (the stub
 *      approves at once) and the callback seals the tokens — then the
 *      server's own tools are listed for them;
 *   3. in chat, find_tools reaches the server by what the admin wrote about
 *      it, its tools become callable, and a read runs straight through the
 *      delegate to the server with the person's token;
 *   4. Disconnect ends the grant;
 *   5. the same page at phone width.
 *
 * The person is the test's own; `mcp_servers` and the model roster are
 * organization-wide, so the servers carry distinctive `e2e_` prefixes and
 * the model a tag, and both are removed through the console's own DELETE
 * routes afterwards. The stub keeps its own state (registrations, tokens,
 * calls) and is reset at the start of each test, so the tests run one at a
 * time, in desktop-light only.
 *
 * The chat's model is the sandbox stub's Anthropic stand-in (it answers
 * `[[call tool {args}]]` by calling the tool), staged on the roster through
 * the admin route; the chat is created through the chat's own route.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const STUB = 'http://127.0.0.1:8093';
const STUB_MODEL_BASE_URL = 'http://127.0.0.1:8092/anthropic';
/** First hits compile routes in `next dev`. */
const COLD = { timeout: 30_000 };

const SERVER_NAME = 'E2E Acme Docs';
const SLUG = 'e2e_acme_docs';
const CONTEXT =
  'Insurance policies and claims for the Acme carrier. Use it to look up a policy or file a claim.';

test.use({ roles: ['renkei-user', 'renkei-operator'] });
test.describe.configure({ mode: 'serial' });

// eslint-disable-next-line no-empty-pattern
test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'The stub is one server: one project.');
  await fetch(`${STUB}/__reset`);
});

/** What the test listed goes again, through the console's own route. */
test.afterEach(async ({ page, person: _person }, testInfo) => {
  if (testInfo.project.name !== 'desktop-light') return;
  const listed: { servers: { id: string; slug: string }[] } = await (
    await page.request.get('/api/admin/mcp-servers')
  ).json();
  for (const server of listed.servers.filter((row) => row.slug.startsWith('e2e_'))) {
    expect((await page.request.delete(`/api/admin/mcp-servers/${server.id}`)).ok()).toBe(true);
  }
});

async function serverIdOf(page: Page, slug: string): Promise<string> {
  const listed: { servers: { id: string; slug: string }[] } = await (
    await page.request.get('/api/admin/mcp-servers')
  ).json();
  const id = listed.servers.find((row) => row.slug === slug)?.id;
  if (!id) throw new Error(`no server ${slug}`);
  return id;
}

/** The chat's model on the roster, the way an operator adds one. */
async function addChatModel(page: Page, tag: string): Promise<string> {
  const response = await page.request.post('/api/admin/llm-models', {
    data: {
      label: `MCP e2e model ${tag}`,
      provider: 'anthropic',
      model: 'e2e-model',
      baseUrl: STUB_MODEL_BASE_URL,
      apiKey: 'e2e',
      enabled: true,
      isDefault: false,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body: { id: string } = await response.json();
  return body.id;
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

async function stubState(): Promise<{
  registrations: number;
  tokensIssued: number;
  calls: { name: string; args: Record<string, unknown>; who: string }[];
}> {
  return (await fetch(`${STUB}/__state`)).json();
}

async function adminAddsTheServer(
  page: Page,
  testInfo: TestInfo,
  name = SERVER_NAME,
  options: { path?: string; transport?: 'sse'; open?: boolean; slug?: string } = {}
) {
  await page.goto('/admin/mcp');
  await expect(page.getByRole('heading', { name: 'MCP servers' })).toBeVisible(COLD);
  await page.getByRole('button', { name: '+ Add MCP server' }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Server URL', { exact: true }).fill(`${STUB}${options.path ?? '/mcp'}`);
  if (options.transport) await page.getByLabel('Transport').selectOption(options.transport);
  if (options.open) await page.getByLabel('Sign-in').selectOption('none');
  await page.getByLabel(/^Context/).fill(CONTEXT);
  if (options.slug) await page.getByLabel(/^Tool prefix/).fill(options.slug);
  await shot(page, testInfo, 'mcp-01-admin-form');
  await page.getByRole('button', { name: 'Add server' }).click();
  const row = page.getByTestId('mcp-server-list').getByRole('listitem').filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByText(`${options.slug ?? SLUG}__*`)).toBeVisible();
  await expect(row.getByText(CONTEXT)).toBeVisible();
  return row;
}

test('an admin lists a server, a person connects it through the server’s own sign-in, and chat finds and calls its tools', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(240_000);
  const modelId = await addChatModel(page, randomUUID().slice(0, 6));
  try {
    // ── 1. The admin lists the server and checks it ─────────────────────
    const row = await adminAddsTheServer(page, testInfo);
    await row.getByRole('button', { name: 'Check' }).click();
    await expect(row.getByText(/Reachable — signs in at http:\/\/127\.0\.0\.1:8093/)).toBeVisible(
      COLD
    );
    // Checking registered Renkei at the server (dynamic registration), once.
    await expect(row.getByText(/Renkei has a client registered there/)).toBeVisible();
    // (Once per deployment: the registration outlives the server row, so a run
    // after an earlier one on the same memory server finds it made already.)
    const registered = (await stubState()).registrations;
    expect(registered).toBeLessThanOrEqual(1);
    await shot(page, testInfo, 'mcp-02-admin-checked');

    // ── 2. A person connects it: the server signs them in ────────────────
    await page.goto('/connectors');
    const card = page.getByRole('main').getByTestId(`mcp-server-${SLUG}`);
    await expect(card).toBeVisible(COLD);
    await expect(card.getByText(CONTEXT)).toBeVisible();
    await expect(card.getByText('connected')).toHaveCount(0);
    await shot(page, testInfo, 'mcp-03-connect');
    await card.getByRole('link', { name: 'Connect' }).click();
    // authorize → delegate prepare (registers Renkei) → stub /authorize →
    // /api/oauth/callback → delegate exchange + commit → tool list → back.
    await page.waitForURL('**/connectors', COLD);
    const connected = page.getByRole('main').getByTestId(`mcp-server-${SLUG}`);
    await expect(connected.getByText('connected')).toBeVisible(COLD);
    await expect(connected.getByRole('button', { name: 'Tools (2)' })).toBeVisible();
    const afterConnect = await stubState();
    // The registration from the admin's check was reused, not repeated.
    expect(afterConnect.registrations).toBe(registered);
    expect(afterConnect.tokensIssued).toBe(1);

    await connected.getByRole('button', { name: 'Tools (2)' }).click();
    await expect(connected.getByText(`${SLUG}__lookup_policy`)).toBeVisible(COLD);
    await expect(connected.getByText(`${SLUG}__file_claim`)).toBeVisible();
    await expect(connected.getByText('Look up an insurance policy by number.')).toBeVisible();
    await shot(page, testInfo, 'mcp-04-connected-tools');

    // The server announces a change: the cached list follows with nobody
    // pressing Refresh (the watch opened when the person connected).
    const serverId = await serverIdOf(page, SLUG);
    await fetch(`${STUB}/__tools`, { method: 'POST' });
    await expect
      .poll(
        async () => {
          const answer = await page.request.get(`/api/mcp-servers/${serverId}/tools`);
          return (await answer.json()).tools.length;
        },
        { timeout: 30_000 }
      )
      .toBe(3);
    await page.reload();
    await expect(
      page
        .getByRole('main')
        .getByTestId(`mcp-server-${SLUG}`)
        .getByRole('button', { name: 'Tools (3)' })
    ).toBeVisible(COLD);
    await shot(page, testInfo, 'mcp-04b-list-changed');
    await fetch(`${STUB}/__reset`);

    // The agent builder offers the server's tools like any connector's: an
    // agent names the tools it may use, and the save validates them against
    // the owner's tool projection.
    await page.goto('/agents/new');
    const picker = page.getByRole('region', { name: 'Tools' });
    await picker.getByRole('textbox', { name: 'Search tools' }).fill('lookup');
    await expect(picker.getByText(`${SLUG} (MCP server)`)).toBeVisible(COLD);
    const lookup = picker.getByRole('checkbox', { name: 'lookup_policy' });
    await expect(lookup).toBeVisible(COLD);
    await expect(picker.getByRole('checkbox', { name: 'file_claim' })).toHaveCount(0);
    await lookup.check();
    await expect(picker.getByTestId('tool-count')).toContainText('1 of at most');
    await shot(page, testInfo, 'mcp-04c-agent-builder');

    // ── 3. Chat: find_tools reaches the server by what the admin wrote ───
    const created = await page.request.post('/api/chat/chats', { data: { llmModelId: modelId } });
    expect(created.status(), await created.text()).toBe(201);
    const { chatId } = await created.json();
    const renamed = await page.request.patch(`/api/chat/chats/${chatId}`, {
      data: { title: 'Look up a policy' },
    });
    expect(renamed.ok()).toBe(true);
    await page.goto(`/chat/${chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Look up a policy' })).toBeVisible(
      COLD
    );
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill('[[call find_tools {"query":"insurance claims"}]]');
    await box.press('Enter');
    await expect(page.getByText('Stub model: I saw').first()).toBeVisible(COLD);
    // The tool result is folded in the thread; it is in the page all the same.
    const found = page.locator('pre.chat-pre').filter({ hasText: `About ${SERVER_NAME}` });
    await expect(found.first()).toBeAttached(COLD);
    await expect(found.first()).toContainText(CONTEXT);
    await expect(found.first()).toContainText(`${SLUG}__lookup_policy`);
    await expect(found.first()).toContainText(`${SLUG}__file_claim`);
    await shot(page, testInfo, 'mcp-05-chat-found');

    // A read runs straight through, as the person, at the server.
    await box.fill(`[[call ${SLUG}__lookup_policy {"policyNumber":"P-1001"}]]`);
    await box.press('Enter');
    await expect.poll(async () => (await stubState()).calls.length, { timeout: 30_000 }).toBe(1);
    const call = (await stubState()).calls[0];
    expect(call).toMatchObject({ name: 'lookup_policy', args: { policyNumber: 'P-1001' } });
    expect(call.who).toMatch(/^stub-client-/);

    // An act asks first, like any other write in chat.
    await box.fill(`[[call ${SLUG}__file_claim {"policyNumber":"P-1001","summary":"Hail"}]]`);
    await box.press('Enter');
    const ask = page.getByRole('group', { name: 'Permission needed' });
    await expect(ask).toBeVisible(COLD);
    expect((await stubState()).calls.length).toBe(1);
    await ask.getByRole('button', { name: 'Allow once' }).click();
    await expect.poll(async () => (await stubState()).calls.length, { timeout: 30_000 }).toBe(2);
    expect((await stubState()).calls[1].name).toBe('file_claim');
    await shot(page, testInfo, 'mcp-06-chat-act');

    // ── 4. Disconnect ends the grant and the cached tools ────────────────
    await page.goto('/connectors');
    const again = page.getByRole('main').getByTestId(`mcp-server-${SLUG}`);
    await again.getByRole('button', { name: 'Refresh tools' }).click();
    // Refreshed from the server (which is back to two tools): the list opens on them.
    await expect(again.getByRole('listitem')).toHaveCount(2, COLD);
    await again.getByRole('button', { name: 'Disconnect' }).click();
    await expect(again.getByRole('link', { name: 'Connect' })).toBeVisible(COLD);
    await expect(again.getByText('connected')).toHaveCount(0);
    await shot(page, testInfo, 'mcp-07-disconnected');
  } finally {
    expect((await page.request.delete(`/api/admin/llm-models/${modelId}`)).ok()).toBe(true);
  }
});

test('the legacy SSE transport and an open server work the same way', async ({
  page,
  person: _person,
}, testInfo) => {
  // A server on the legacy HTTP+SSE transport: signs people in like any other.
  const sseRow = await adminAddsTheServer(page, testInfo, 'E2E Legacy SSE', {
    path: '/sse',
    transport: 'sse',
    slug: 'e2e_legacy',
  });
  await expect(sseRow.getByText('SSE', { exact: true })).toBeVisible();
  // An open server: no sign-in at all.
  const openRow = await adminAddsTheServer(page, testInfo, 'E2E Open Docs', {
    path: '/open/mcp',
    open: true,
    slug: 'e2e_open',
  });
  await expect(openRow.getByText('no sign-in')).toBeVisible();

  await page.goto('/connectors');
  const legacy = page.getByRole('main').getByTestId('mcp-server-e2e_legacy');
  await expect(legacy.getByText('SSE', { exact: true })).toBeVisible(COLD);
  await legacy.getByRole('link', { name: 'Connect' }).click();
  await page.waitForURL('**/connectors', COLD);
  const legacyConnected = page.getByRole('main').getByTestId('mcp-server-e2e_legacy');
  await expect(legacyConnected.getByText('connected')).toBeVisible(COLD);
  // The tool list came over the SSE stream.
  await expect(legacyConnected.getByRole('button', { name: 'Tools (2)' })).toBeVisible();

  // The legacy stream carries the change notice too.
  const legacyId = await serverIdOf(page, 'e2e_legacy');
  await fetch(`${STUB}/__tools`, { method: 'POST' });
  await expect
    .poll(
      async () => {
        const answer = await page.request.get(`/api/mcp-servers/${legacyId}/tools`);
        return (await answer.json()).tools.length;
      },
      { timeout: 30_000 }
    )
    .toBe(3);

  // The open server needs no connect: its tools are listed on first sight.
  const open = page.getByRole('main').getByTestId('mcp-server-e2e_open');
  await expect(open.getByText('open', { exact: true })).toBeVisible();
  await expect(open.getByRole('button', { name: 'Tools (2)' })).toBeVisible(COLD);
  await expect(open.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
  await shot(page, testInfo, 'mcp-10-transports');
});

test('the admin list and the connect card at phone width', async ({
  page,
  person: _person,
}, testInfo) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await adminAddsTheServer(page, testInfo, 'E2E Acme Docs');
  await shot(page, testInfo, 'mcp-08-admin-mobile');

  await page.goto('/connectors');
  const card = page.getByRole('main').getByTestId(`mcp-server-${SLUG}`);
  await expect(card.getByRole('link', { name: 'Connect' })).toBeVisible(COLD);
  // No horizontal scroll at phone width.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'mcp-09-connect-mobile');
});
