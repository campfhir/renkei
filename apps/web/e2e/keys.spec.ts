/**
 * The person's encryption key, where only a browser shows it
 * (docs/delegate-key-design.md): a first sign-in enrolls the browser with
 * real WebCrypto and IndexedDB, shows the key once and keeps it on the
 * device (@smoke, unchanged); a rotation's new key opens a chat the lost
 * delegation closed, typed back once; a key service this browser has not
 * met is named by its real fingerprint and confirmed once; the dialog and
 * the section fit a phone; and an operator removes a departed person's
 * key from the Access page, once.
 *
 * Where the rules went:
 *   - the key dialog (which moment shows, dismissing to a banner and back,
 *     a typed key refused or taken, "Not now" on the trust dialog, asks
 *     and approvals by code, the earlier passphrase): components/key-guard.model.test.ts;
 *   - the Preferences section (what is enabled, what pause, forget,
 *     rotation and approvals leave on screen, an unconfirmed key service):
 *     app/(app)/preferences/encryption-key-section.model.test.ts;
 *   - "Remove key" (offered for others only, asked twice, a wrong typed
 *     name is a no, what a refusal leaves): app/(app)/admin/access/shred-key-button.model.test.ts;
 *   - the removal route (operator-only, never one's own key, the person's
 *     sessions end, the key service down): app/api/admin/access/[subject]/keys/route.test.ts.
 *
 * Driven against the real delegate the memory server runs in-process and
 * the real key routes. Each test's person is its own and signs in
 * unenrolled (`enroll: false`), so the browser enrolls them exactly as on
 * a first sign-in and the key the page shows is the one the test types
 * back. A chat is created through the chat's routes and answered by the
 * stand-in model (e2e/llm-stub.mjs), which an operator stages on the roster
 * under the test's own tag.
 *
 * "The delegate forgets" (what a delegate restart leaves: nothing that
 * opens this session's key) is the browser's own route for dropping this
 * session's delegation (POST /api/keys/delegate with `revokeSession`), and
 * what is delegated is read where the KeyGuard reads it (GET /api/keys).
 *
 * Not reachable here: the second device approving by code (the Postgres
 * spec signed the same person in again with a second session). A session
 * only comes from an OIDC sign-in or the suite's test sign-in route, which
 * makes a new person every time; there is no way to give one person a
 * second browser session. What the approval leaves on screen is the
 * models'.
 *
 * Pinned Chromium; "mobile" is a resized viewport rather than the `mobile`
 * project's device descriptor, per AGENTS.md.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { createPerson, signIn, type Person } from './support/person';
import { addStubModel, removeModel } from './support/stub-model';
import { LLM_STUB_REPLY } from './constants';
import { test, expect } from './fixtures';
import { settled as turnSettled } from './support/chat';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const PROMPT_TEXT = 'Why did the sprint slip by two days?';
const KEY_PATTERN = /^([a-z2-7]{4}-){13}[a-z2-7]{4}$/;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

// The fixture person (the Access page's operator, last test) is an operator.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

function tagOf(testInfo: TestInfo): string {
  return `${testInfo.project.name.replace('desktop-', '')}-${randomUUID().slice(0, 6)}`;
}

/** The ten-character code a browser shows for a public key (lib/keys device codes). */
function deviceCodeOf(publicKey: Buffer): string {
  const digest = createHash('sha256').update(publicKey).digest();
  let raw = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      raw += BASE32[(buffer >> bits) & 31];
    }
  }
  const chars = raw.slice(0, 10).toUpperCase();
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

interface KeyView {
  enrolled: boolean;
  legacy: boolean;
  publicKey: string | null;
  sessionDelegated: boolean;
  automationInstances: unknown[];
}

/** What the KeyGuard reads: GET /api/keys, as this browser's session. */
async function keyView(page: Page): Promise<KeyView> {
  // Once more on a dropped keep-alive socket (the dev server closes idle ones).
  const response = await page.request.get('/api/keys').catch(() => page.request.get('/api/keys'));
  expect(response.ok()).toBe(true);
  return response.json();
}

/** The delegate forgets this session's key: the browser's own route for dropping it. */
async function dropDelegation(page: Page): Promise<void> {
  const send = () =>
    page.request.post('/api/keys/delegate', {
      data: { session: [], automation: [], revokeSession: true },
    });
  // Once more on a dropped keep-alive socket (the dev server closes idle ones).
  const response = await send().catch(() => send());
  expect(response.ok(), await response.text()).toBe(true);
  expect((await keyView(page)).sessionDelegated).toBe(false);
}

/**
 * The KeyGuard checks on focus; a reload is the surest way to make it look
 * again. The guard may itself refresh the page as the reload starts (it
 * re-seals, then refreshes server data), which aborts the reload: the page
 * it lands on is the one to read either way.
 */
async function recheck(page: Page): Promise<void> {
  await page.reload().catch(async (error: unknown) => {
    if (!String(error).includes('ERR_ABORTED')) throw error;
    await page.waitForLoadState();
  });
}

/** A person of the test's own, signed in but not enrolled: the browser enrolls them. */
async function freshPerson(
  page: Page,
  request: APIRequestContext,
  roles: string[] = ['renkei-user', 'renkei-operator']
): Promise<Person> {
  const person = await createPerson(request, { roles, enroll: false });
  await signIn(page.context(), person);
  return person;
}

/** The first sign-in's dialog: the key shown once, read off the page, then confirmed. */
async function enrollInBrowser(page: Page): Promise<string> {
  await page.goto(`/`);
  const dialog = page.getByRole('dialog', { name: 'Your encryption key is ready' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const shown = (await page.getByTestId('key-reveal-text').innerText()).trim();
  expect(shown).toMatch(KEY_PATTERN);
  await page.getByTestId('key-reveal-confirm').click();
  await expect(dialog).toHaveCount(0);
  return shown;
}

/** A chat of the person's own, asked one question and answered by the stand-in model. */
async function chatOf(page: Page, modelId: string, title: string): Promise<string> {
  const created = await page.request.post('/api/chat/chats', { data: { llmModelId: modelId } });
  expect(created.status(), await created.text()).toBe(201);
  const { chatId } = await created.json();
  const renamed = await page.request.patch(`/api/chat/chats/${chatId}`, { data: { title } });
  expect(renamed.ok(), await renamed.text()).toBe(true);
  const asked = await page.request.post(`/api/chat/chats/${chatId}/turns`, {
    data: { text: PROMPT_TEXT, llmModelId: modelId },
  });
  expect(asked.status(), await asked.text()).toBe(202);
  // The reply is written by the turn on the server: wait for it to finish,
  // then open the chat once.
  await turnSettled(page.request, chatId);
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('main').getByText(LLM_STUB_REPLY).first()).toBeVisible();
  return chatId;
}

async function expectChatReadable(page: Page, chatId: string, title: string): Promise<void> {
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page.getByRole('main').getByText(PROMPT_TEXT).first()).toBeVisible();
  await expect(page.getByRole('main').getByText(LLM_STUB_REPLY).first()).toBeVisible();
  await expect(page.getByTestId('chat-key-unavailable-notice')).toHaveCount(0);
}

/** Preferences → "Forget this device": the browser no longer holds the key. */
async function forgetDevice(page: Page): Promise<void> {
  await page.goto(`/preferences`);
  const section = page.getByTestId('encryption-key').filter({ visible: true }).first();
  await section.getByRole('button', { name: 'Forget this device' }).click();
  await expect(section.getByTestId('encryption-key-device')).toContainText(
    'does not hold your key'
  );
}

test('a first sign-in enrolls the browser, shows the key once, and keeps it on the device @smoke', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  await freshPerson(page, request, ['renkei-user']);

  // Nothing asked of the person: the key exists by the time the page settles,
  // and is shown front and center in a dialog nothing else can dismiss.
  await page.goto(`/`);
  const dialog = page.getByRole('dialog', { name: 'Your encryption key is ready' });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole('button', { name: 'Close' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await shot(page, testInfo, 'keys-01-enrolled-dialog');
  const enrolled = await keyView(page);
  expect(enrolled.enrolled).toBe(true);
  expect(enrolled.legacy).toBe(false);
  expect(enrolled.publicKey).toBeTruthy();
  expect(enrolled.sessionDelegated).toBe(true);
  expect(enrolled.automationInstances.length).toBeGreaterThan(0);

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
  await page.goto(`/preferences`);
  const section = page.getByTestId('encryption-key').filter({ visible: true }).first();
  await expect(section.getByTestId('encryption-key-mode')).toContainText('You hold your own key');
  await expect(section.getByTestId('encryption-key-state')).toContainText(
    'Your agents can run until'
  );
  await expect(section.getByTestId('encryption-key-device')).toContainText(
    'This browser holds your key'
  );
  await shot(page, testInfo, 'keys-03-preferences');

  // Pause the agents: the automation delegation goes; the session's stays.
  // (Hydrated first: a click before it lands on nothing.)
  await page.waitForLoadState('networkidle');
  await section.getByTestId('encryption-key-pause').click();
  await expect(section.getByTestId('encryption-key-state')).toContainText('paused');
  const paused = await keyView(page);
  expect(paused.automationInstances).toHaveLength(0);
  expect(paused.sessionDelegated).toBe(true);

  // The delegate forgets: the device still has the key, so the page seals again by itself.
  await dropDelegation(page);
  await recheck(page);
  await expect
    .poll(async () => (await keyView(page)).sessionDelegated, { timeout: 30_000 })
    .toBe(true);
  await expect(page.getByTestId('key-modal-needs-key')).toHaveCount(0);

  // Forget the device, lose the delegation: now the person must bring the key.
  await section.getByRole('button', { name: 'Forget this device' }).click();
  await expect(section.getByTestId('encryption-key-device')).toContainText(
    'does not hold your key'
  );
  await dropDelegation(page);
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
    .poll(async () => (await keyView(page)).sessionDelegated, { timeout: 30_000 })
    .toBe(true);
});

test('a chat follows the key: a rotation, a lost delegation, the new key typed back', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  const tag = tagOf(testInfo);
  const title = `Sprint slippage ${tag}`;
  await freshPerson(page, request);
  const userKey = await enrollInBrowser(page);
  const modelId = await addStubModel(page.request, tag);
  try {
    const chatId = await chatOf(page, modelId, title);

    // Rotation (WebCrypto re-wraps under a new key, sealed afresh): shown
    // once, and the chat still opens through the new delegation.
    await page.goto(`/preferences`);
    const section = page.getByTestId('encryption-key').filter({ visible: true }).first();
    await section.getByTestId('encryption-key-rotate-start').click();
    await section.getByTestId('encryption-key-rotate-confirm').click();
    const revealed = section.getByTestId('encryption-key-revealed');
    await expect(revealed).toBeVisible({ timeout: 30_000 });
    const newKey = (await section.getByTestId('encryption-key-revealed-text').innerText()).trim();
    expect(newKey).toMatch(KEY_PATTERN);
    expect(newKey).not.toBe(userKey);
    await shot(page, testInfo, 'keys-06-rotated');
    await section.getByRole('button', { name: 'I have written it down' }).click();
    await expectChatReadable(page, chatId, title);

    // This device lets the key go, and the delegate forgets: the chat says
    // why, and the page asks for the key.
    await forgetDevice(page);
    await dropDelegation(page);
    await page.goto(`/chat/${chatId}`);
    const notice = page.getByTestId('chat-key-unavailable-notice');
    await expect(notice.first()).toBeVisible({ timeout: 30_000 });
    await expect(notice.first()).toContainText('not connected to this session');
    await expect(page.getByRole('main').getByText(PROMPT_TEXT)).toHaveCount(0);
    await shot(page, testInfo, 'keys-05-chat-not-connected');
    await expect(page.getByTestId('key-modal-needs-key')).toBeVisible();

    // The old key no longer opens the account's wrappings; the new one
    // does, and the chat opens without a reload by hand.
    const unlock = page.getByTestId('key-unlock');
    await unlock.getByLabel('Type the key you wrote down').fill(userKey);
    await page.getByTestId('key-unlock-submit').click();
    await expect(unlock.getByRole('alert')).toBeVisible();
    await unlock.getByLabel('Type the key you wrote down').fill(newKey);
    await page.getByTestId('key-unlock-submit').click();
    await expect(unlock).toHaveCount(0);
    await expect(page.getByRole('main').getByText(PROMPT_TEXT).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(notice).toHaveCount(0);
  } finally {
    await removeModel(page.request, modelId).catch(() => removeModel(page.request, modelId));
  }
});

test('a key service this browser has not met is confirmed by fingerprint before anything is sealed', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(180_000);
  await freshPerson(page, request);
  await enrollInBrowser(page);

  // The web app now claims one more instance, with a key the deployment's
  // signing key never signed — what a compromised web app would do. The
  // browser names its fingerprint and seals nothing until the person says so.
  const planted = randomBytes(32).toString('base64');
  await page.route(`**/api/keys`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.instances = [...json.instances, { id: randomUUID(), publicKey: planted }];
    json.sessionDelegated = false;
    json.instancesMissingSession = [...json.instancesMissingSession, 'planted'];
    await route.fulfill({ response, json });
  });
  await dropDelegation(page);
  await recheck(page);
  const trust = page.getByTestId('key-modal-trust');
  await expect(trust).toBeVisible({ timeout: 30_000 });
  const fingerprint = (await trust.getByTestId('key-trust-fingerprint').innerText()).trim();
  expect(fingerprint).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  expect(fingerprint).toBe(deviceCodeOf(Buffer.from(planted, 'base64')));
  expect((await keyView(page)).sessionDelegated).toBe(false);
  await shot(page, testInfo, 'keys-09-trust-dialog');

  // Confirmed: the browser seals (the delegate drops the instance nobody
  // runs) and remembers. "Not now" and its banner are the model's.
  await trust.getByTestId('key-trust-confirm').click();
  await expect
    .poll(async () => (await keyView(page)).sessionDelegated, { timeout: 30_000 })
    .toBe(true);
  await page.unroute(`**/api/keys`);
  await recheck(page);
  await expect(page.getByTestId('key-modal-trust')).toHaveCount(0);
});

test('the key dialog and the section at phone width', async ({ page, request }, testInfo) => {
  await freshPerson(page, request, ['renkei-user']);
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`/`);
  const dialog = page.getByTestId('key-modal-write-down');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  await expect(page.getByTestId('key-reveal-text')).toBeVisible();
  await shot(page, testInfo, 'keys-mobile-01-dialog');
  await page.getByTestId('key-reveal-confirm').click();
  await page.goto(`/preferences`);
  const section = page.getByTestId('encryption-key').filter({ visible: true }).first();
  await expect(section.getByTestId('encryption-key-mode')).toContainText('You hold your own key');
  const sectionBox = await section.boundingBox();
  expect(sectionBox).not.toBeNull();
  expect((sectionBox?.x ?? 0) + (sectionBox?.width ?? Infinity)).toBeLessThanOrEqual(
    MOBILE_VIEWPORT.width
  );
  await shot(page, testInfo, 'keys-mobile-03-preferences');
});

test('an operator removes a departed person’s key from the Access page, never their own', async ({
  page,
  request,
  person,
}, testInfo) => {
  const leaverName = `E2E Leaver ${tagOf(testInfo)}`;
  // Enrolled the way their browser would have, then gone.
  const leaver = await createPerson(request, { displayName: leaverName });
  const leaverKeys = async (): Promise<KeyView> =>
    (await request.get('/api/keys', { headers: leaver.headers })).json();
  expect((await leaverKeys()).enrolled).toBe(true);

  await page.goto(`/admin/access`);
  await expect(page.getByRole('heading', { name: 'Access' })).toBeVisible();
  // The operator's own key is theirs to remove from Preferences only.
  await expect(page.getByTestId(`shred-key-${person.subject}`)).toHaveCount(0);
  const button = page.getByTestId(`shred-key-${leaver.subject}`);
  await expect(button).toBeVisible();
  await shot(page, testInfo, 'keys-admin-01-access');

  // Asked twice: in words, then by typing the name (a wrong name is the
  // model's). The removal reaches the route and the button goes with the key.
  const answers: string[] = [];
  page.on('dialog', (dialog) => {
    answers.push(dialog.type());
    if (dialog.type() === 'prompt') void dialog.accept(leaverName);
    else void dialog.accept();
  });
  const removed = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      response.url().endsWith(`/api/admin/access/${encodeURIComponent(leaver.subject)}/keys`)
  );
  await button.click();
  expect((await removed).status()).toBe(200);
  expect(answers).toEqual(['confirm', 'prompt']);
  await expect(button).toHaveCount(0, { timeout: 15_000 });
  await shot(page, testInfo, 'keys-admin-02-removed');
});
