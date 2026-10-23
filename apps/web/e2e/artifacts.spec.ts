/**
 * Artifacts, end to end in a browser (docs/artifacts-design.md): the
 * library page with its filters and details panel; rename, share and
 * delete-with-impact on one file; a project page's Artifacts card with
 * the Always / On demand switch and attaching from the library; and the
 * composer's "where should it go?" chooser in a project chat. Every act
 * goes through the real routes against the real dev database; only the
 * composer's upload is mocked at the browser edge, since e2e has no blob
 * store.
 *
 * Each Playwright project gets its own person, project, chat and files,
 * derived from the project name (the llm-models.spec.ts pattern): the
 * specs run concurrently against one database, and this one creates and
 * deletes rows.
 *
 * Runs on the pinned Chromium; "phone" is a resized viewport, not the
 * mobile project's device descriptor (AGENTS.md).
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { enrollForE2E, keyFor } from './keys';
import { deleteRowsOf } from './seed';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

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
  const id = (name: string) => uuidFrom(`artifacts-e2e:${name}:${projectName}`);
  return {
    subject: `e2e-artifact-lib-${projectName}@example.com`,
    friend: `e2e-artifact-lib-${projectName}-friend@example.com`,
    sessionId: id('session'),
    modelId: id('model'),
    projectId: id('project'),
    projectName: `Billing API (${projectName})`,
    chatId: id('chat'),
    guideId: id('guide'),
    reportId: id('report'),
    manualId: id('manual'),
  };
}
type Fixture = ReturnType<typeof fixtureFor>;

/** The Playwright project a fixture was made for — the tail of its subject. */
const testProject = (f: Fixture): string =>
  f.subject.replace(/^e2e-artifact-lib-/, '').replace(/@example\.com$/, '');

/** A model secret as the app seals it (TOKEN_ENCRYPTION_KEY, AES-GCM) — artifact-inline.spec.ts's helper. */
function sealSecret(plaintext: string): string {
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (key.byteLength !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes.');
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

const GUIDE_TEXT =
  '# Postgres schema guide\n\nMonetary columns are numeric(12,4). Round half to even at the boundary, never in storage.\n';
const REPORT_TEXT = '# Rounding analysis\n\nThree call sites round per line; one rounds once.\n';
const MANUAL_TEXT = 'Vendor SDK manual. Retries are exponential with jitter.\n';

async function seed(f: Fixture): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('DELETE FROM resource_access_grants WHERE resource_id = ANY($1)', [
      [f.guideId, f.reportId, f.manualId],
    ]);
    await deleteRowsOf(
      client,
      [f.subject, f.friend],
      [
        'artifact_references',
        'artifacts',
        'chats',
        'chat_projects',
        'user_preferences',
        'sessions',
        'identities',
      ]
    );
    await client.query('DELETE FROM llm_model_configs WHERE id = $1', [f.modelId]);
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at) VALUES ($1, $2, $3, $4)`,
      [f.sessionId, f.subject, ['renkei-user'], new Date(Date.now() + 24 * 3_600_000)]
    );
    await client.query(
      `INSERT INTO identities (subject, email, display_name) VALUES ($1, $1, 'Artifacts Tester'), ($2, $2, 'Priya Friend')`,
      [f.subject, f.friend]
    );
    await client.query(
      `INSERT INTO user_preferences (subject, key, value)
       VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)
       ON CONFLICT (subject, key) DO UPDATE SET value = EXCLUDED.value`,
      [f.subject]
    );
    await enrollForE2E(client, f.subject);
    await enrollForE2E(client, f.friend);
    await client.query(
      `INSERT INTO llm_model_configs (id, label, provider, model, base_url, encrypted_secrets, enabled, is_default)
       VALUES ($1, $2, 'anthropic', 'e2e-model', 'http://127.0.0.1:8092/anthropic', $3, true, false)`,
      [
        f.modelId,
        `Chatty (artifacts ${testProject(f)})`,
        sealSecret(JSON.stringify({ apiKey: 'e2e' })),
      ]
    );
    await client.query(
      `INSERT INTO chat_projects (id, owner_subject, name, description, kind)
       VALUES ($1, $2, $3, 'Invoices and refunds.', 'chat')`,
      [f.projectId, f.subject, f.projectName]
    );
    await keyFor(client, {
      kind: 'chat_project',
      resourceId: f.projectId,
      ownerSubject: f.subject,
    });
    await client.query(
      `INSERT INTO chats (id, owner_subject, project_id, title, llm_model_id, last_message_at)
       VALUES ($1, $2, $3, 'Fix invoice rounding', $4, NOW())`,
      [f.chatId, f.subject, f.projectId, f.modelId]
    );
    const chatKey = await keyFor(client, {
      kind: 'chat',
      resourceId: f.chatId,
      ownerSubject: f.subject,
    });
    // An upload of the person's own, under a key of its own, held by the project.
    const guideKey = await keyFor(client, {
      kind: 'artifact',
      resourceId: f.guideId,
      ownerSubject: f.subject,
    });
    await client.query(
      `INSERT INTO artifacts (id, owner_subject, chat_id, blob_key, filename, content_type, size_bytes, extract_status, extracted_text, origin, key_kind)
       VALUES ($1, $2, NULL, $3, 'schema-guide.md', 'text/markdown', $4, 'done', $5, 'upload', 'artifact')`,
      [f.guideId, f.subject, `chat/e2e/${f.guideId}`, GUIDE_TEXT.length, guideKey.seal(GUIDE_TEXT)]
    );
    await client.query(
      `INSERT INTO artifact_references (artifact_id, project_id, mode, added_by) VALUES ($1, $2, 'on_demand', $3)`,
      [f.guideId, f.projectId, f.subject]
    );
    // A file the model wrote in the chat: the chat's, under the chat's key.
    await client.query(
      `INSERT INTO artifacts (id, owner_subject, chat_id, blob_key, filename, content_type, size_bytes, extract_status, extracted_text, origin, key_kind, key_ref)
       VALUES ($1, $2, $3, $4, 'rounding-analysis.md', 'text/markdown', $5, 'done', $6, 'model', 'chat', $3)`,
      [
        f.reportId,
        f.subject,
        f.chatId,
        `chat/e2e/${f.reportId}`,
        REPORT_TEXT.length,
        chatKey.seal(REPORT_TEXT),
      ]
    );
    // A colleague's file, shared with the person.
    const manualKey = await keyFor(client, {
      kind: 'artifact',
      resourceId: f.manualId,
      ownerSubject: f.friend,
    });
    await client.query(
      `INSERT INTO artifacts (id, owner_subject, chat_id, blob_key, filename, content_type, size_bytes, extract_status, extracted_text, origin, key_kind)
       VALUES ($1, $2, NULL, $3, 'vendor-sdk-manual.txt', 'text/plain', $4, 'done', $5, 'upload', 'artifact')`,
      [
        f.manualId,
        f.friend,
        `chat/e2e/${f.manualId}`,
        MANUAL_TEXT.length,
        manualKey.seal(MANUAL_TEXT),
      ]
    );
    await client.query(
      `INSERT INTO resource_access_grants (resource_kind, resource_id, owner_subject, grantee_subject, role)
       VALUES ('artifact', $1, $2, $3, 'viewer')`,
      [f.manualId, f.friend, f.subject]
    );
  } finally {
    await client.end();
  }
}

async function signIn(page: Page, f: Fixture): Promise<void> {
  await page.context().addCookies([
    {
      name: 'renkei_session',
      value: f.sessionId,
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

test('the library: filters, details, rename, share, delete with its impact', async ({
  page,
}, testInfo) => {
  const f = fixtureFor(testInfo.project.name);
  await seed(f);
  await signIn(page, f);

  await page.goto('/chat/artifacts');
  await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible();
  const list = page.getByRole('region', { name: 'Artifacts' });
  await expect(list.getByText('schema-guide.md')).toBeVisible();
  await expect(list.getByText('rounding-analysis.md')).toBeVisible();
  await expect(list.getByText('vendor-sdk-manual.txt')).toBeVisible();
  await expect(list.getByText(/generated in “Fix invoice rounding”/)).toBeVisible();
  await expect(list.getByText(/shared by Priya Friend/)).toBeVisible();
  await shot(page, testInfo, 'artifacts-01-library');

  // The filters narrow to what each kind of file is.
  await page.getByRole('button', { name: 'Generated', exact: true }).click();
  await expect(list.getByText('rounding-analysis.md')).toBeVisible();
  await expect(list.getByText('schema-guide.md')).toBeHidden();
  await page.getByRole('button', { name: 'Shared with me', exact: true }).click();
  await expect(list.getByText('vendor-sdk-manual.txt')).toBeVisible();
  await expect(list.getByText('rounding-analysis.md')).toBeHidden();
  await page.getByRole('button', { name: 'All', exact: true }).click();

  // The details panel: where it is used, and the owner's acts.
  await list.getByRole('button', { name: /schema-guide\.md/ }).click();
  const details = page.getByRole('complementary', { name: 'Selected artifact' });
  await expect(details).toBeVisible();
  await expect(details.getByRole('link', { name: f.projectName })).toBeVisible();
  await expect(details.getByText('owned by you')).toBeVisible();
  await shot(page, testInfo, 'artifacts-02-details');

  await details.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('File name').fill('postgres-schema-guide.md');
  await page.getByRole('button', { name: 'Rename' }).last().click();
  await expect(list.getByText('postgres-schema-guide.md')).toBeVisible();

  // Share with a colleague: they get "use", never "edit".
  await details.getByRole('button', { name: 'Share…' }).click();
  const share = page.getByRole('dialog');
  await expect(share.getByText(/Sharing lets a person use it/)).toBeVisible();
  // By email: every Playwright project seeds a Priya of its own.
  await share.getByPlaceholder('Name or email').fill(f.friend);
  await share.getByRole('button', { name: f.friend }).click();
  await share.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(share.getByText('Priya Friend')).toBeVisible();
  await expect(share.getByText('use')).toBeVisible();
  await shot(page, testInfo, 'artifacts-03-share');
  await share.getByRole('button', { name: 'Close' }).click();

  // Delete: the impact first, hand-over as the default, deletion on purpose.
  await details.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm.getByText('Deleting removes the file for everyone')).toBeVisible();
  await expect(confirm.getByText(f.projectName)).toBeVisible();
  await expect(confirm.getByText(/Shared with Priya Friend/)).toBeVisible();
  await expect(confirm.getByLabel(/Hand it over instead/)).toBeChecked();
  await shot(page, testInfo, 'artifacts-04-delete-impact');
  await confirm.getByLabel(/Delete it for everyone/).check();
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(list.getByText('postgres-schema-guide.md')).toBeHidden();
  await expect(list.getByText('rounding-analysis.md')).toBeVisible();

  // A colleague's file: a copy of one's own, or off the list — never edit.
  await list.getByRole('button', { name: /vendor-sdk-manual\.txt/ }).click();
  await expect(details.getByRole('button', { name: 'Make a copy I own' })).toBeVisible();
  await expect(details.getByRole('button', { name: 'Rename' })).toHaveCount(0);
  await details.getByRole('button', { name: 'Remove from my artifacts' }).click();
  await expect(list.getByText('vendor-sdk-manual.txt')).toBeHidden();
});

test('a project page: the Artifacts card, Always against the budget, attach from the library', async ({
  page,
}, testInfo) => {
  const f = fixtureFor(testInfo.project.name);
  await seed(f);
  await signIn(page, f);

  await page.goto(`/chat/projects/${f.projectId}`);
  const card = page.getByRole('region', { name: 'Artifacts' });
  await expect(card.getByText('schema-guide.md')).toBeVisible();
  await expect(card.getByText('1 attached')).toBeVisible();
  await expect(card.getByText('1 searched on demand')).toBeVisible();

  // Always: the whole text travels with every turn, counted against the budget.
  await card
    .getByRole('radiogroup', { name: "How this project's chats use schema-guide.md" })
    .getByRole('radio', { name: 'Always' })
    .click();
  await expect(card.getByText('0 searched on demand')).toBeVisible();
  await expect(card.getByText(/1 file · \d+ tokens of 24k tokens per turn/)).toBeVisible();
  await shot(page, testInfo, 'artifacts-05-project-card');

  // Attach the chat's generated file from the library.
  await card.getByRole('button', { name: 'Attach from library…' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByRole('button', { name: 'Generated in chats' }).click();
  await picker.getByLabel('Attach rounding-analysis.md').check();
  await picker.getByRole('button', { name: /^Attach 1$/ }).click();
  await expect(card.getByText('rounding-analysis.md')).toBeVisible();
  await expect(card.getByText('2 attached')).toBeVisible();
  await expect(card.getByText(/generated in/)).toBeVisible();

  // Detach: the file stays in the library, the project lets go of it.
  await card
    .getByRole('button', { name: `Remove rounding-analysis.md from ${f.projectName}` })
    .click();
  await expect(card.getByText('rounding-analysis.md')).toBeHidden();
  await page.goto('/chat/artifacts');
  await expect(
    page.getByRole('region', { name: 'Artifacts' }).getByText('rounding-analysis.md')
  ).toBeVisible();
});

test('a project chat: a dropped file asks where it goes', async ({ page }, testInfo) => {
  const f = fixtureFor(testInfo.project.name);
  await seed(f);
  await signIn(page, f);
  // No blob store in e2e: the upload is answered at the browser edge, and
  // what the composer asked for — a plain chat upload, or one kept for the
  // project — is what this checks.
  const uploads: string[] = [];
  await page.route('**/api/chat/attachments?*', async (route) => {
    uploads.push(new URL(route.request().url()).search);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        attachment: {
          id: uuidFrom(`upload:${uploads.length}`),
          filename: 'stripe-webhooks.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1_400_000,
          extractStatus: 'done',
        },
        attached: null,
      }),
    });
  });

  await page.goto(`/chat/${f.chatId}`);
  await expect(page.getByLabel('Message')).toBeVisible();
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: 'stripe-webhooks.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 e2e'),
    });
  const chooser = page.getByRole('group', { name: 'Where should the files go?' });
  await expect(chooser.getByText('Where should stripe-webhooks.pdf go?')).toBeVisible();
  await expect(chooser.getByLabel(/Artifacts, attached to Billing API/)).toBeChecked();
  await shot(page, testInfo, 'artifacts-06-drop-chooser');
  await chooser.getByLabel(/This message only/).check();
  await chooser.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('stripe-webhooks.pdf')).toBeVisible();
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).not.toContain('keep=1');
  // Remembered: the next file goes the same way without asking.
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: 'second.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 e2e 2'),
    });
  await expect(chooser).toBeHidden();
  await expect.poll(() => uploads.length).toBe(2);
});

test('a project chat: Send answers the chooser, and the remembered choice can be changed', async ({
  page,
}, testInfo) => {
  const f = fixtureFor(testInfo.project.name);
  await seed(f);
  await signIn(page, f);
  const uploads: string[] = [];
  await page.route('**/api/chat/attachments?*', async (route) => {
    uploads.push(new URL(route.request().url()).search);
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        attachment: {
          id: uuidFrom(`send-upload:${uploads.length}`),
          filename: 'retry-policy.md',
          contentType: 'text/markdown',
          sizeBytes: 900,
          extractStatus: 'done',
        },
        attached: { mode: 'on_demand' },
      }),
    });
  });

  await page.goto(`/chat/${f.chatId}`);
  await expect(page.getByLabel('Message')).toBeVisible();
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: 'retry-policy.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Retries\n\nExponential, with jitter.'),
    });
  const chooser = page.getByRole('group', { name: 'Where should the files go?' });
  await expect(chooser).toBeVisible();
  // No Add: the message is sent with the choice as it stands (the project).
  await page.getByRole('textbox', { name: 'Message' }).fill('Follow the retry policy.');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(chooser).toBeHidden();
  await expect.poll(() => uploads.length).toBe(1);
  expect(uploads[0]).toContain('keep=1');
  expect(uploads[0]).toContain(`projectId=${f.projectId}`);
  // The file is attached to the message that went out with it.
  await expect(page.getByRole('link', { name: 'retry-policy.md' })).toBeVisible();

  // The remembered choice shows beside the paperclip; clicking it asks again next time.
  const remembered = page.getByRole('button', { name: 'Files → artifacts' });
  await expect(remembered).toBeVisible();
  await shot(page, testInfo, 'artifacts-09-remembered-control');
  await remembered.click();
  await expect(remembered).toBeHidden();
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: 'again.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('again'),
    });
  await expect(chooser).toBeVisible();
});

test('phone: the library and the project card fit the viewport', async ({ page }, testInfo) => {
  const f = fixtureFor(testInfo.project.name);
  await seed(f);
  await signIn(page, f);
  await page.setViewportSize(MOBILE_VIEWPORT);

  await page.goto('/chat/artifacts');
  const list = page.getByRole('region', { name: 'Artifacts' });
  await expect(list.getByText('schema-guide.md')).toBeVisible();
  await list.getByRole('button', { name: /schema-guide\.md/ }).click();
  await expect(page.getByRole('complementary', { name: 'Selected artifact' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'artifacts-07-phone-library');

  await page.goto(`/chat/projects/${f.projectId}`);
  const card = page.getByRole('region', { name: 'Artifacts' });
  await expect(card.getByText('schema-guide.md')).toBeVisible();
  await expect(card.getByRole('radio', { name: 'On demand' })).toBeVisible();
  await shot(page, testInfo, 'artifacts-08-phone-project');
});
