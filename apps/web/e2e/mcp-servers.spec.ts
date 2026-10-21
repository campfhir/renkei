/**
 * Remote MCP servers, end to end against a stand-in server (mcp-stub.mjs)
 * with its own OAuth — through the real web app, the real delegate and the
 * real database; nothing in between is mocked.
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
 * The person is the spec's own (AGENTS.md: isolate what you create);
 * `mcp_servers` is organization-wide, so the rows written here carry a
 * distinctive prefix and only they are cleared.
 */

import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { enrollForE2E, keyFor } from './keys';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const STUB = 'http://127.0.0.1:8093';
const STUB_MODEL_BASE_URL = 'http://127.0.0.1:8092/anthropic';
/** First hits compile routes in `next dev`. */
const COLD = { timeout: 30_000 };

const SERVER_NAME = 'E2E Acme Docs';
const SLUG = 'e2e_acme_docs';
const CONTEXT =
  'Insurance policies and claims for the Acme carrier. Use it to look up a policy or file a claim.';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

function uuidFrom(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function fixtureFor(projectName: string) {
  return {
    sessionId: uuidFrom(`mcp-servers-e2e-session:${projectName}`),
    subject: `e2e-mcp-servers-${projectName}@example.com`,
    chatId: uuidFrom(`mcp-servers-e2e-chat:${projectName}`),
    modelId: uuidFrom(`mcp-servers-e2e-model:${projectName}`),
  };
}
type Fixture = ReturnType<typeof fixtureFor>;

function sealSecret(plaintext: string): string {
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

async function seed(fixture: Fixture): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(`DELETE FROM mcp_servers WHERE slug LIKE 'e2e\\_%'`);
  await client.query('DELETE FROM chats WHERE id = $1', [fixture.chatId]);
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [fixture.modelId]);
  await client.query('DELETE FROM provider_grants WHERE subject = $1', [fixture.subject]);
  await client.query('DELETE FROM sessions WHERE subject = $1', [fixture.subject]);
  await client.query('DELETE FROM identities WHERE subject = $1', [fixture.subject]);
  await client.query(
    `INSERT INTO sessions (id, subject, roles, expires_at) VALUES ($1, $2, $3, $4)`,
    [
      fixture.sessionId,
      fixture.subject,
      ['renkei-user', 'renkei-operator'],
      new Date(Date.now() + 24 * 3_600_000),
    ]
  );
  await client.query(`INSERT INTO identities (subject, email, display_name) VALUES ($1, $1, $2)`, [
    fixture.subject,
    'E2E Tester',
  ]);
  await client.query(
    `INSERT INTO user_preferences (subject, key, value)
     VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)
     ON CONFLICT (subject, key) DO UPDATE SET value = EXCLUDED.value`,
    [fixture.subject]
  );
  await enrollForE2E(client, fixture.subject);
  await fetch(`${STUB}/__reset`);
  return client;
}

async function seedChat(client: Client, fixture: Fixture): Promise<void> {
  await client.query(
    `INSERT INTO llm_model_configs (id, label, provider, model, base_url, encrypted_secrets, enabled, is_default)
     VALUES ($1, 'MCP e2e model', 'anthropic', 'e2e-model', $2, $3, true, false)`,
    [fixture.modelId, STUB_MODEL_BASE_URL, sealSecret(JSON.stringify({ apiKey: 'e2e' }))]
  );
  await client.query(
    `INSERT INTO chats (id, owner_subject, title, llm_model_id, last_message_at)
     VALUES ($1, $2, 'Look up a policy', $3, NOW())`,
    [fixture.chatId, fixture.subject, fixture.modelId]
  );
  const chatKey = await keyFor(client, {
    kind: 'chat',
    resourceId: fixture.chatId,
    ownerSubject: fixture.subject,
  });
  const turnId = uuidFrom(`mcp-servers-e2e-turn:${fixture.chatId}`);
  await client.query(
    `INSERT INTO chat_turns (id, chat_id, status, llm_model_id, iterations, finished_at)
     VALUES ($1, $2, 'completed', $3, 1, NOW())`,
    [turnId, fixture.chatId, fixture.modelId]
  );
  await client.query(
    `INSERT INTO chat_messages (chat_id, turn_id, seq, role, kind, status, content)
     VALUES ($1, $2, 1, 'user', 'prompt', 'complete', $3)`,
    [fixture.chatId, turnId, chatKey.seal(JSON.stringify([{ type: 'text', text: 'Hello' }]))]
  );
  // A finished reply, so the next message is a turn of its own (the stub
  // model answers the first line of the LAST user message, and two user
  // messages in a row would merge).
  await client.query(
    `INSERT INTO chat_messages (chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model)
     VALUES ($1, $2, 2, 'assistant', 'assistant', 'complete', $3, $4, 'anthropic', 'e2e-model')`,
    [
      fixture.chatId,
      turnId,
      chatKey.seal(JSON.stringify([{ type: 'text', text: 'Hi — what do you need?' }])),
      fixture.modelId,
    ]
  );
}

async function signIn(page: Page, fixture: Fixture): Promise<void> {
  await page.context().addCookies([
    {
      name: 'renkei_session',
      value: fixture.sessionId,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
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
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const fixture = fixtureFor(testInfo.project.name);
  const client = await seed(fixture);
  try {
    await signIn(page, fixture);

    // ── 1. The admin lists the server and checks it ─────────────────────
    const row = await adminAddsTheServer(page, testInfo);
    await row.getByRole('button', { name: 'Check' }).click();
    await expect(row.getByText(/Reachable — signs in at http:\/\/127\.0\.0\.1:8093/)).toBeVisible(
      COLD
    );
    // Checking registered Renkei at the server (dynamic registration), once.
    await expect(row.getByText(/Renkei has a client registered there/)).toBeVisible();
    expect((await stubState()).registrations).toBe(1);
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
    expect(afterConnect.registrations).toBe(1);
    expect(afterConnect.tokensIssued).toBe(1);

    await connected.getByRole('button', { name: 'Tools (2)' }).click();
    await expect(connected.getByText(`${SLUG}__lookup_policy`)).toBeVisible();
    await expect(connected.getByText(`${SLUG}__file_claim`)).toBeVisible();
    await expect(connected.getByText('Look up an insurance policy by number.')).toBeVisible();
    await shot(page, testInfo, 'mcp-04-connected-tools');

    // The server announces a change: the cached list follows with nobody
    // pressing Refresh (the watch opened when the person connected).
    const serverId = (
      await client.query<{ id: string }>('SELECT id FROM mcp_servers WHERE slug = $1', [SLUG])
    ).rows[0].id;
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

    // The grant is the person's, sealed in the delegate — one row, no token column to read.
    const grants = await client.query(
      `SELECT provider FROM provider_grants WHERE subject = $1 AND provider LIKE 'mcp:%'`,
      [fixture.subject]
    );
    expect(grants.rowCount).toBe(1);

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
    await seedChat(client, fixture);
    await page.goto(`/chat/${fixture.chatId}`);
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
    const left = await client.query(
      `SELECT 1 FROM provider_grants WHERE subject = $1 AND provider LIKE 'mcp:%'`,
      [fixture.subject]
    );
    expect(left.rowCount).toBe(0);
    await shot(page, testInfo, 'mcp-07-disconnected');
  } finally {
    await client.query(`DELETE FROM mcp_servers WHERE slug LIKE 'e2e\\_%'`);
    await client.query('DELETE FROM chats WHERE id = $1', [fixture.chatId]);
    await client.query('DELETE FROM llm_model_configs WHERE id = $1', [fixture.modelId]);
    await client.end();
  }
});

test('the legacy SSE transport and an open server work the same way', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  const fixture = fixtureFor(`${testInfo.project.name}-transports`);
  const client = await seed(fixture);
  try {
    await signIn(page, fixture);

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
    const legacyId = (
      await client.query<{ id: string }>('SELECT id FROM mcp_servers WHERE slug = $1', [
        'e2e_legacy',
      ])
    ).rows[0].id;
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
  } finally {
    await client.query(`DELETE FROM mcp_servers WHERE slug LIKE 'e2e\\_%'`);
    await client.end();
  }
});

test('the admin list and the connect card at phone width', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  await page.setViewportSize(MOBILE_VIEWPORT);
  const fixture = fixtureFor(`${testInfo.project.name}-mobile`);
  const client = await seed(fixture);
  try {
    await signIn(page, fixture);
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
  } finally {
    await client.query(`DELETE FROM mcp_servers WHERE slug LIKE 'e2e\\_%'`);
    await client.end();
  }
});
