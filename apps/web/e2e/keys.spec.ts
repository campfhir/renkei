/**
 * The person's encryption key, end to end in a browser
 * (docs/delegate-key-design.md): a first sign-in enrolls the browser
 * without asking, shows the key once and keeps it on the device; a device
 * without the key is told so and takes the key typed in; a lost
 * delegation (a delegate restart) comes back from the device's key; a
 * rotation keeps the chat readable; and a second device gets the key by
 * approving a code on the first.
 *
 * Driven against the real delegate the Playwright config starts and the
 * real key routes; the only thing seeded is the person, their session and
 * one chat with two sealed messages (e2e/keys.ts, enrolled the way a
 * browser would be). Own tenant per test, so nothing races the shared one.
 *
 * Runs on the pinned Chromium only (no WebKit installed in this sandbox —
 * see voice.spec.ts's note); "mobile" is a resized viewport rather than
 * the `mobile` project's device descriptor, per AGENTS.md.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { deviceCodeOf, enrollForE2E, formatUserKey, keyFor, secretbox } from './keys';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const PROMPT_TEXT = 'Why did the sprint slip by two days?';
const REPLY_TEXT = 'Two tickets were blocked on the vendor API outage on Tuesday.';
const KEY_PATTERN = /^([a-z2-7]{4}-){13}[a-z2-7]{4}$/;

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

interface Fixture {
  tenantId: string;
  sessionId: string;
  slug: string;
  subject: string;
  chatId: string;
  turnId: string;
  modelId: string;
}

function fixtureFor(name: string): Fixture {
  return {
    tenantId: uuidFrom(`keys-e2e-tenant:${name}`),
    sessionId: uuidFrom(`keys-e2e-session:${name}`),
    slug: `e2e-keys-${name}`,
    subject: `e2e-keys-${name}@example.com`,
    chatId: uuidFrom(`keys-e2e-chat:${name}`),
    turnId: uuidFrom(`keys-e2e-turn:${name}`),
    modelId: uuidFrom(`keys-e2e-model:${name}`),
  };
}

/** `llm_model_configs.encrypted_secrets` is a bare secretbox under TOKEN_ENCRYPTION_KEY. */
function sealSecret(plaintext: string): string {
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (key.byteLength !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes for this spec to seed rows.');
  }
  return secretbox(plaintext, key);
}

async function withDb<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** A tenant and a signed-in person; with `chat`, one chat of theirs with two sealed messages. */
async function seed(fixture: Fixture, options: { chat: boolean }): Promise<Buffer | null> {
  return withDb(async (client) => {
    await client.query('DELETE FROM chats WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM resource_keys WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM user_encryption_keys WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM llm_model_configs WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM user_preferences WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM sessions WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM identities WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM tenants WHERE id = $1', [fixture.tenantId]);
    await client.query('INSERT INTO tenants (id, slug) VALUES ($1, $2)', [
      fixture.tenantId,
      fixture.slug,
    ]);
    await client.query(
      `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        fixture.sessionId,
        fixture.tenantId,
        fixture.subject,
        ['renkei-user', 'renkei-operator'],
        new Date(Date.now() + 24 * 3_600_000),
      ]
    );
    await client.query(
      `INSERT INTO identities (tenant_id, subject, email, display_name)
       VALUES ($1, $2, $3, $4)`,
      [fixture.tenantId, fixture.subject, fixture.subject, 'E2E Tester']
    );
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.tenantId, fixture.subject]
    );
    await client.query(
      `INSERT INTO llm_model_configs (id, tenant_id, label, provider, model, encrypted_secrets, enabled, is_default)
       VALUES ($1, $2, 'E2E model', 'anthropic', 'e2e-model', $3, true, true)`,
      [fixture.modelId, fixture.tenantId, sealSecret(JSON.stringify({ apiKey: 'e2e' }))]
    );
    if (!options.chat) return null;
    await client.query(
      `INSERT INTO chats (id, tenant_id, owner_subject, title, llm_model_id, last_message_at)
       VALUES ($1, $2, $3, 'Sprint slippage', $4, NOW())`,
      [fixture.chatId, fixture.tenantId, fixture.subject, fixture.modelId]
    );
    const keys = await enrollForE2E(client, fixture.tenantId, fixture.subject);
    const chatKey = await keyFor(client, {
      tenantId: fixture.tenantId,
      kind: 'chat',
      resourceId: fixture.chatId,
      ownerSubject: fixture.subject,
    });
    await client.query(
      `INSERT INTO chat_turns (id, tenant_id, chat_id, status, llm_model_id, iterations, input_tokens, output_tokens, finished_at)
       VALUES ($1, $2, $3, 'completed', $4, 1, 120, 34, NOW())`,
      [fixture.turnId, fixture.tenantId, fixture.chatId, fixture.modelId]
    );
    const rows = [
      { seq: 0, role: 'user', kind: 'prompt', text: PROMPT_TEXT },
      { seq: 1, role: 'assistant', kind: 'assistant', text: REPLY_TEXT },
    ];
    for (const row of rows) {
      const assistant = row.role === 'assistant';
      await client.query(
        `INSERT INTO chat_messages (tenant_id, chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model, stop_reason)
         VALUES ($1, $2, $3, $4, $5, $6, 'complete', $7, $8, $9, $10, $11)`,
        [
          fixture.tenantId,
          fixture.chatId,
          fixture.turnId,
          row.seq,
          row.role,
          row.kind,
          chatKey.seal(JSON.stringify([{ type: 'text', text: row.text }])),
          assistant ? fixture.modelId : null,
          assistant ? 'anthropic' : null,
          assistant ? 'e2e-model' : null,
          assistant ? 'end_turn' : null,
        ]
      );
    }
    return keys.userKey;
  });
}

async function signIn(page: Page, fixture: Fixture, sessionId = fixture.sessionId): Promise<void> {
  await page.context().addCookies([
    {
      name: `renkei_session_${fixture.tenantId}`,
      value: sessionId,
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

async function delegationCount(fixture: Fixture, scope?: string): Promise<number> {
  return withDb(async (client) => {
    const result = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM key_delegations
        WHERE tenant_id = $1 AND subject = $2 AND expires_at > NOW()
          AND ($3::text IS NULL OR scope = $3)`,
      [fixture.tenantId, fixture.subject, scope ?? null]
    );
    return Number(result.rows[0]?.count ?? 0);
  });
}

/** What a delegate restart leaves behind: rows nothing can open. Here, simply none. */
async function dropDelegations(fixture: Fixture): Promise<void> {
  await withDb((client) =>
    client.query('DELETE FROM key_delegations WHERE tenant_id = $1 AND subject = $2', [
      fixture.tenantId,
      fixture.subject,
    ])
  );
}

/** The KeyGuard checks on focus; a reload is the surest way to make it look again. */
async function recheck(page: Page): Promise<void> {
  await page.reload();
}

async function expectChatReadable(page: Page, fixture: Fixture): Promise<void> {
  await page.goto(`/${fixture.slug}/chat/${fixture.chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Sprint slippage' })).toBeVisible();
  await expect(page.getByText(PROMPT_TEXT)).toBeVisible();
  await expect(page.getByText(REPLY_TEXT)).toBeVisible();
  await expect(page.getByTestId('chat-key-unavailable-notice')).toHaveCount(0);
}

test('a first sign-in enrolls the browser, shows the key once, and keeps it on the device', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(`enroll-${testInfo.project.name}`);
  await seed(fixture, { chat: false });
  await signIn(page, fixture);

  // Nothing asked of the person: the key exists by the time the page settles,
  // and is shown front and center in a dialog nothing else can dismiss.
  await page.goto(`/${fixture.slug}`);
  const dialog = page.getByRole('dialog', { name: 'Your encryption key is ready' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole('button', { name: 'Close' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await shot(page, testInfo, 'keys-01-enrolled-dialog');
  const enrolled = await withDb(async (client) => {
    const row = await client.query<{ mode: string; public_key: string | null }>(
      `SELECT mode, public_key FROM user_encryption_keys WHERE tenant_id = $1 AND subject = $2`,
      [fixture.tenantId, fixture.subject]
    );
    return row.rows[0];
  });
  expect(enrolled?.mode).toBe('held');
  expect(enrolled?.public_key).toBeTruthy();
  expect(await delegationCount(fixture, 'session')).toBeGreaterThan(0);
  expect(await delegationCount(fixture, 'automation')).toBeGreaterThan(0);

  // Shown once, in the written-down form, until the person says they have it.
  const reveal = page.getByTestId('key-reveal');
  await expect(reveal).toBeVisible();
  const shown = (await page.getByTestId('key-reveal-text').innerText()).trim();
  expect(shown).toMatch(KEY_PATTERN);
  await page.getByTestId('key-reveal-confirm').click();
  await expect(reveal).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await recheck(page);
  await expect(page.getByTestId('key-modal-write-down')).toHaveCount(0);

  // The preferences section says what the person now has.
  await page.goto(`/${fixture.slug}/preferences`);
  const section = page.getByTestId('encryption-key');
  await expect(section.getByTestId('encryption-key-mode')).toContainText('You hold your own key');
  await expect(section.getByTestId('encryption-key-state')).toContainText(
    'Your agents can run until'
  );
  await expect(section.getByTestId('encryption-key-device')).toContainText(
    'This browser holds your key'
  );
  await shot(page, testInfo, 'keys-03-preferences');

  // Pause the agents: the automation delegation goes; the session's stays.
  await section.getByTestId('encryption-key-pause').click();
  await expect(section.getByTestId('encryption-key-state')).toContainText('paused');
  expect(await delegationCount(fixture, 'automation')).toBe(0);
  expect(await delegationCount(fixture, 'session')).toBeGreaterThan(0);

  // A delegate restart: the device still has the key, so the page seals again by itself.
  await dropDelegations(fixture);
  await recheck(page);
  await expect
    .poll(() => delegationCount(fixture, 'session'), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await expect(page.getByTestId('key-modal-needs-key')).toHaveCount(0);

  // Forget the device, lose the delegation: now the person must bring the key.
  await section.getByRole('button', { name: 'Forget this device' }).click();
  await expect(section.getByTestId('encryption-key-device')).toContainText(
    'does not hold your key'
  );
  await dropDelegations(fixture);
  await recheck(page);
  const needsKey = page.getByTestId('key-modal-needs-key');
  await expect(needsKey).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, 'keys-04-needs-key');
  // Dismissable — the key is needed, but maybe not for this page — with a
  // banner left behind as the way back in.
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(needsKey).toHaveCount(0);
  const needsKeyBanner = page.getByTestId('key-banner-needs-key');
  await expect(needsKeyBanner).toBeVisible();
  await shot(page, testInfo, 'keys-04b-needs-key-banner');
  await needsKeyBanner.getByRole('button', { name: 'Add my key' }).click();
  await expect(needsKey).toBeVisible();
  const unlock = page.getByTestId('key-unlock');
  await unlock
    .getByLabel('Type the key you wrote down')
    .fill(`${shown.slice(0, -1)}${shown.endsWith('a') ? 'b' : 'a'}`);
  await page.getByTestId('key-unlock-submit').click();
  await expect(unlock.getByRole('alert')).toContainText('check the key');
  await unlock.getByLabel('Type the key you wrote down').fill(shown.toUpperCase());
  await page.getByTestId('key-unlock-submit').click();
  await expect(unlock).toHaveCount(0);
  await expect(needsKey).toHaveCount(0);
  await expect
    .poll(() => delegationCount(fixture, 'session'), { timeout: 30_000 })
    .toBeGreaterThan(0);
});

test('a seeded chat follows the key: lost delegation, typed key, rotation, a second device', async ({
  page,
  browser,
}, testInfo) => {
  const fixture = fixtureFor(`chat-${testInfo.project.name}`);
  const userKey = await seed(fixture, { chat: true });
  expect(userKey).not.toBeNull();
  if (!userKey) return;
  await signIn(page, fixture);

  // Readable through the seeded delegation, with no key on this device yet.
  await expectChatReadable(page, fixture);
  await expect(page.getByTestId('key-modal-needs-key')).toHaveCount(0);

  // The delegate forgets: the chat says why, and the page asks for the key.
  await dropDelegations(fixture);
  await page.goto(`/${fixture.slug}/chat/${fixture.chatId}`);
  const notice = page.getByTestId('chat-key-unavailable-notice');
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText('not connected to this session');
  await expect(page.getByText(PROMPT_TEXT)).toHaveCount(0);
  await shot(page, testInfo, 'keys-05-chat-not-connected');
  const needsKey = page.getByTestId('key-modal-needs-key');
  await expect(needsKey).toBeVisible();
  await page
    .getByTestId('key-unlock')
    .getByLabel('Type the key you wrote down')
    .fill(formatUserKey(userKey));
  await page.getByTestId('key-unlock-submit').click();
  await expect(page.getByTestId('key-unlock')).toHaveCount(0);
  // The page refreshes its server data once the key is back; the chat opens.
  await expect(page.getByText(PROMPT_TEXT)).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveCount(0);

  // Rotation: a new key, shown once; the chat still opens afterwards.
  await page.goto(`/${fixture.slug}/preferences`);
  const section = page.getByTestId('encryption-key');
  await section.getByTestId('encryption-key-rotate-start').click();
  await section.getByTestId('encryption-key-rotate-confirm').click();
  const revealed = section.getByTestId('encryption-key-revealed');
  await expect(revealed).toBeVisible({ timeout: 30_000 });
  const newKey = (await section.getByTestId('encryption-key-revealed-text').innerText()).trim();
  expect(newKey).toMatch(KEY_PATTERN);
  expect(newKey).not.toBe(formatUserKey(userKey));
  await shot(page, testInfo, 'keys-06-rotated');
  await section.getByRole('button', { name: 'I have written it down' }).click();
  await expectChatReadable(page, fixture);

  // A second device, signed in as the same person with a session of its own:
  // no key here, so it asks; the first device shows the code and approves.
  const secondSession = randomUUID();
  await withDb((client) =>
    client.query(
      `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [
        secondSession,
        fixture.tenantId,
        fixture.subject,
        ['renkei-user'],
        new Date(Date.now() + 3_600_000),
      ]
    )
  );
  const second = await (browser satisfies Browser).newContext();
  const other = await second.newPage();
  await signIn(other, fixture, secondSession);
  await other.goto(`/${fixture.slug}/chat/${fixture.chatId}`);
  const otherNeeds = other.getByTestId('key-modal-needs-key');
  await expect(otherNeeds).toBeVisible({ timeout: 30_000 });
  await other.getByRole('button', { name: 'Ask my other devices' }).click();
  const codeText = await other.getByTestId('key-unlock-code').innerText();
  const code = /([A-Z2-7]{5}-[A-Z2-7]{5})/.exec(codeText)?.[1] ?? '';
  expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  await shot(other, testInfo, 'keys-07-second-device-asks');

  // The first device sees when and from what browser, never the code: the
  // person types it off the asking screen. A wrong code is refused and the
  // request stays; the right one, typed any old way, approves it.
  await recheck(page);
  const approve = page.getByTestId('key-modal-approve');
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await expect(approve).not.toContainText(code);
  await expect(approve.getByTestId('key-approve-request')).toHaveCount(1);
  await expect(approve).toContainText('Chrome');
  const codeInput = approve.getByLabel('The code the other device shows');
  await expect(approve.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await codeInput.fill(code.endsWith('A') ? 'BBBBB-BBBBB' : 'AAAAA-AAAAA');
  await approve.getByRole('button', { name: 'Approve' }).click();
  await expect(approve.getByRole('alert')).toContainText('not the code');
  await expect(approve.getByTestId('key-approve-request')).toHaveCount(1);
  await shot(page, testInfo, 'keys-08-first-device-approves');
  await codeInput.fill(code.toLowerCase().replace('-', ' '));
  await approve.getByRole('button', { name: 'Approve' }).click();
  await expect(approve).toHaveCount(0);

  // The asking device picks the key up on its own and the chat opens there too.
  await expect(other.getByTestId('key-unlock')).toHaveCount(0, { timeout: 30_000 });
  await expect(other.getByText(PROMPT_TEXT)).toBeVisible({ timeout: 30_000 });
  await expect(other.getByTestId('chat-key-unavailable-notice')).toHaveCount(0);
  await second.close();
});

test('a key service this browser has not met is confirmed by fingerprint before anything is sealed', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(`trust-${testInfo.project.name}`);
  const userKey = await seed(fixture, { chat: true });
  expect(userKey).not.toBeNull();
  if (!userKey) return;
  await signIn(page, fixture);

  // First use on this browser: the live instances are trusted on sight and
  // the device gets the key by typing it, sealing without a question.
  await dropDelegations(fixture);
  await page.goto(`/${fixture.slug}/chat/${fixture.chatId}`);
  await expect(page.getByTestId('key-modal-needs-key')).toBeVisible({ timeout: 30_000 });
  await page
    .getByTestId('key-unlock')
    .getByLabel('Type the key you wrote down')
    .fill(formatUserKey(userKey));
  await page.getByTestId('key-unlock-submit').click();
  await expect(page.getByText(PROMPT_TEXT)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('key-modal-trust')).toHaveCount(0);

  // The web app now claims one more instance, with a key the deployment's
  // signing key never signed — what a compromised web app would do. The
  // browser names its fingerprint and seals nothing until the person says so.
  const planted = randomBytes(32).toString('base64');
  await page.route(`**/api/tenant/${fixture.tenantId}/keys`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.instances = [...json.instances, { id: randomUUID(), publicKey: planted }];
    json.sessionDelegated = false;
    json.instancesMissingSession = [...json.instancesMissingSession, 'planted'];
    await route.fulfill({ response, json });
  });
  await dropDelegations(fixture);
  await page.reload();
  const trust = page.getByTestId('key-modal-trust');
  await expect(trust).toBeVisible({ timeout: 30_000 });
  const fingerprint = (await trust.getByTestId('key-trust-fingerprint').innerText()).trim();
  expect(fingerprint).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  expect(fingerprint).toBe(deviceCodeOf(Buffer.from(planted, 'base64')));
  expect(await delegationCount(fixture, 'session')).toBe(0);
  await shot(page, testInfo, 'keys-09-trust-dialog');
  // Not now: the key stays unsealed and a banner is the way back.
  await trust.getByRole('button', { name: 'Not now' }).click();
  await expect(trust).toHaveCount(0);
  await expect(page.getByTestId('key-banner-trust')).toBeVisible();
  expect(await delegationCount(fixture, 'session')).toBe(0);
  // Confirmed: the browser seals (the delegate drops the instance nobody runs) and remembers.
  await page.getByTestId('key-banner-trust').getByRole('button', { name: 'Review' }).click();
  await trust.getByTestId('key-trust-confirm').click();
  await expect
    .poll(() => delegationCount(fixture, 'session'), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await page.unroute(`**/api/tenant/${fixture.tenantId}/keys`);
  await page.reload();
  await expect(page.getByTestId('key-modal-trust')).toHaveCount(0);
  await expect(page.getByText(PROMPT_TEXT)).toBeVisible({ timeout: 30_000 });
});

test('the key dialog and the section at phone width', async ({ page }, testInfo) => {
  const fixture = fixtureFor(`mobile-${testInfo.project.name}`);
  await seed(fixture, { chat: false });
  await signIn(page, fixture);
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`/${fixture.slug}`);
  const dialog = page.getByTestId('key-modal-write-down');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  await expect(page.getByTestId('key-reveal-text')).toBeVisible();
  await shot(page, testInfo, 'keys-mobile-01-dialog');
  await page.getByTestId('key-reveal-confirm').click();
  await page.goto(`/${fixture.slug}/preferences`);
  const section = page.getByTestId('encryption-key');
  await expect(section.getByTestId('encryption-key-mode')).toContainText('You hold your own key');
  const sectionBox = await section.boundingBox();
  expect(sectionBox).not.toBeNull();
  expect(sectionBox!.x + sectionBox!.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  await shot(page, testInfo, 'keys-mobile-03-preferences');
});

test('an operator removes a departed person’s key from the Access page, never their own', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(`shred-${testInfo.project.name}`);
  const leaver = `e2e-keys-leaver-${testInfo.project.name}@example.com`;
  await seed(fixture, { chat: true });
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO identities (tenant_id, subject, email, display_name)
       VALUES ($1, $2, $3, 'E2E Leaver')`,
      [fixture.tenantId, leaver, leaver]
    );
    await enrollForE2E(client, fixture.tenantId, leaver);
  });
  await signIn(page, fixture);

  await page.goto(`/${fixture.slug}/admin/access`);
  await expect(page.getByRole('heading', { name: 'Access' })).toBeVisible();
  // The operator's own key is theirs to remove from Preferences only.
  await expect(page.getByTestId(`shred-key-${fixture.subject}`)).toHaveCount(0);
  const button = page.getByTestId(`shred-key-${leaver}`);
  await expect(button).toBeVisible();
  await shot(page, testInfo, 'keys-admin-01-access');

  // Asked twice: in words, then by typing the name. A wrong name is a no.
  const answers: string[] = [];
  page.on('dialog', (dialog) => {
    answers.push(dialog.type());
    if (dialog.type() === 'prompt')
      void dialog.accept(answers.length === 2 ? 'Someone Else' : 'E2E Leaver');
    else void dialog.accept();
  });
  await button.click();
  await expect.poll(() => answers.length).toBe(2);
  await expect(button).toBeVisible();
  expect(
    await withDb(async (client) => {
      const row = await client.query(
        'SELECT 1 FROM user_encryption_keys WHERE tenant_id = $1 AND subject = $2',
        [fixture.tenantId, leaver]
      );
      return row.rowCount;
    })
  ).toBe(1);

  await button.click();
  await expect.poll(() => answers.length).toBe(4);
  await expect(button).toHaveCount(0, { timeout: 15_000 });
  const after = await withDb(async (client) => {
    const keys = await client.query(
      'SELECT 1 FROM user_encryption_keys WHERE tenant_id = $1 AND subject = $2',
      [fixture.tenantId, leaver]
    );
    const grants = await client.query(
      'SELECT 1 FROM resource_key_grants WHERE tenant_id = $1 AND holder = $2',
      [fixture.tenantId, leaver]
    );
    const own = await client.query(
      'SELECT 1 FROM user_encryption_keys WHERE tenant_id = $1 AND subject = $2',
      [fixture.tenantId, fixture.subject]
    );
    return { keys: keys.rowCount, grants: grants.rowCount, own: own.rowCount };
  });
  expect(after).toEqual({ keys: 0, grants: 0, own: 1 });
  await shot(page, testInfo, 'keys-admin-02-removed');
});
