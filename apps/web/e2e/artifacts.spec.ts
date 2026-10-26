/**
 * Artifacts, end to end in a browser (docs/artifacts-design.md): the
 * library page with its filters and details panel; rename, share and
 * delete-with-impact on one file; the list paged in the database and
 * scrolling in its own box, the search finding a file by its name or by
 * the digest (summary and keywords) the model wrote for it, a link
 * opening to the page its file is on; a project page's Artifacts card
 * with the Always / On demand switch and attaching from the library;
 * the composer's "where should it go?" chooser in a project chat; ticking
 * several files in the library to delete them (the impact warned first) or
 * add them to a project; a second press on a project's remove button after the
 * server has answered, which must not reach it again; and,
 * at phone width, the cards that open a file's details over the list, a
 * back button to return. Every act goes through the real routes against
 * the real dev database; the model is the sandbox stub, which answers a
 * digest from the file's own text; only the composer's upload is mocked
 * at the browser edge, since e2e has no blob store.
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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { encrypt, loadKeyring } from '@renkei/crypto';
import { enrollForE2E, keyFor } from './keys';
import { deleteRowsOf } from './seed';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
/**
 * Where the dev server's local blob store keeps its objects (the
 * Playwright config's default); the spec reads them back from disk to
 * see what is at rest. Null when the environment points at another
 * backend, and those checks are skipped.
 */
const BLOBS =
  (process.env.BLOB_STORE_PROVIDER ?? 'local') === 'local'
    ? (process.env.BLOB_STORE_LOCAL_DIR ?? path.join(RESULTS, 'blobs'))
    : null;
const SEALED_MAGIC = Buffer.from('renc2b\0', 'latin1');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** A first visit compiles the page on the dev server; a real upload extracts text. */
const COLD = { timeout: 30_000 };

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
    plainChatId: id('plain-chat'),
    csvId: id('csv'),
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
const CSV_TEXT = 'id,amount\n1,10.00\n';

/** The bytes the local store holds for one artifact, and whether they are sealed. */
async function storedBytes(blobKey: string): Promise<Buffer> {
  if (!BLOBS) throw new Error('no local blob store to read');
  return readFile(path.join(BLOBS, blobKey));
}

/**
 * A file as the store held it before bytes were sealed: the content in
 * the clear, beside the local backend's content-type sidecar.
 */
async function storePlainBlob(blobKey: string, text: string, contentType: string): Promise<void> {
  if (!BLOBS) return;
  const file = path.join(BLOBS, blobKey);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  await writeFile(`${file}.meta.json`, JSON.stringify({ contentType }));
}

async function seed(f: Fixture): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('DELETE FROM resource_access_grants WHERE resource_id = ANY($1)', [
      [f.guideId, f.reportId, f.manualId, f.csvId],
    ]);
    await deleteRowsOf(
      client,
      [f.subject, f.friend],
      [
        'artifact_references',
        'artifacts',
        'chats',
        'chat_projects',
        'document_usage',
        'user_preferences',
        'sessions',
        'identities',
      ]
    );
    await client.query('DELETE FROM llm_model_configs WHERE id = $1', [f.modelId]);
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at) VALUES ($1, $2, $3, $4)`,
      // An operator too: the upload test turns the organization's digest switch on.
      [
        f.sessionId,
        f.subject,
        ['renkei-user', 'renkei-operator'],
        new Date(Date.now() + 24 * 3_600_000),
      ]
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
       VALUES ($1, $2, 'anthropic', 'e2e-model', 'http://127.0.0.1:8092/anthropic', $3, true, true)`,
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
    await digestOf(
      client,
      f.guideId,
      'A Postgres schema guide: how monetary columns are typed and where rounding happens.',
      ['postgres', 'schema', 'monetary columns', 'rounding', 'numeric']
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
    // A plain chat, in no project, with a file dropped into it: in the
    // library like everything else the person owns, named by its chat.
    await client.query(
      `INSERT INTO chats (id, owner_subject, title, llm_model_id, last_message_at)
       VALUES ($1, $2, 'Reconcile March invoices', $3, NOW())`,
      [f.plainChatId, f.subject, f.modelId]
    );
    const plainKey = await keyFor(client, {
      kind: 'chat',
      resourceId: f.plainChatId,
      ownerSubject: f.subject,
    });
    await client.query(
      `INSERT INTO artifacts (id, owner_subject, chat_id, blob_key, filename, content_type, size_bytes, extract_status, extracted_text, origin, key_kind, key_ref)
       VALUES ($1, $2, $3, $4, 'march-invoices.csv', 'text/csv', $5, 'done', $6, 'upload', 'chat', $3)`,
      [
        f.csvId,
        f.subject,
        f.plainChatId,
        `chat/e2e/${f.csvId}`,
        CSV_TEXT.length,
        plainKey.seal(CSV_TEXT),
      ]
    );
    // Its bytes as a store from before this build holds them: in the clear.
    await storePlainBlob(`chat/e2e/${f.csvId}`, CSV_TEXT, 'text/csv');
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
    await digestOf(
      client,
      f.manualId,
      'The vendor SDK manual: retries are exponential with jitter.',
      ['vendor sdk', 'retries', 'jitter']
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

/** A digest as the model would have left it (artifact-digest.ts's storeDigest), in the clear, indexed. */
async function digestOf(
  client: Client,
  artifactId: string,
  summary: string,
  keywords: string[]
): Promise<void> {
  await client.query(
    `UPDATE artifacts
        SET summary = $2, keywords = $3, digest_status = 'done',
            search_vector = setweight(to_tsvector('english', $4), 'A') || setweight(to_tsvector('english', $2), 'B')
      WHERE id = $1`,
    [artifactId, summary, keywords, keywords.join(' ')]
  );
}

/** The digest's state for one file, as the database holds it. */
async function digestStatusOf(
  subject: string,
  filename: string
): Promise<{ id: string; status: string } | null> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string; digest_status: string }>(
      `SELECT id, digest_status FROM artifacts WHERE owner_subject = $1 AND filename = $2`,
      [subject, filename]
    );
    return rows[0] ? { id: rows[0].id, status: rows[0].digest_status } : null;
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
  // A file dropped into a plain chat is here too, named by that chat.
  await expect(list.getByText(/uploaded in “Reconcile March invoices”/)).toBeVisible();
  await shot(page, testInfo, 'artifacts-01-library');

  // The filters narrow to what each kind of file is.
  await page.getByRole('button', { name: 'Uploaded', exact: true }).click();
  await expect(list.getByText('march-invoices.csv')).toBeVisible();
  await expect(list.getByText('rounding-analysis.md')).toBeHidden();
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
  // What the model wrote about it, and a keyword as a search of its own:
  // the guide is found by its digest, the analysis by its name.
  const about = details.getByRole('region', { name: 'About this file' });
  await expect(about.getByText(/A Postgres schema guide/)).toBeVisible();
  await shot(page, testInfo, 'artifacts-02-details');
  await about
    .getByRole('list', { name: 'Keywords' })
    .getByRole('button', { name: 'rounding' })
    .click();
  await expect(page.getByLabel('Search artifacts')).toHaveValue('rounding');
  await expect(list.getByText('rounding-analysis.md')).toBeVisible();
  await expect(list.getByText('schema-guide.md')).toBeVisible();
  await expect(list.getByText('march-invoices.csv')).toBeHidden();
  await expect(page).toHaveURL(/q=rounding/);
  await page.getByLabel('Search artifacts').fill('');
  await expect(list.getByText('march-invoices.csv')).toBeVisible();

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

/**
 * Thirty more files of the person's own, all older than the fixture's, so
 * the fixture's three of theirs lead and the pager has a second page: 25
 * on the first, the oldest eight and the colleague's shared file (the
 * library lists what is shared after what is owned) on the second.
 */
async function seedBacklog(f: Fixture): Promise<string[]> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const ids: string[] = [];
    for (let n = 1; n <= 30; n += 1) {
      const id = uuidFrom(`artifacts-e2e:backlog-${n}:${testProject(f)}`);
      const name = `backlog-${String(n).padStart(2, '0')}.txt`;
      const key = await keyFor(client, {
        kind: 'artifact',
        resourceId: id,
        ownerSubject: f.subject,
      });
      await client.query(
        `INSERT INTO artifacts (id, owner_subject, chat_id, blob_key, filename, content_type, size_bytes, extract_status, extracted_text, origin, key_kind, created_at)
         VALUES ($1, $2, NULL, $3, $4, 'text/plain', 12, 'done', $5, 'upload', 'artifact', NOW() - INTERVAL '1 day' - $6 * INTERVAL '1 minute')`,
        [id, f.subject, `chat/e2e/${id}`, name, key.seal('backlog note'), n]
      );
      ids.push(id);
    }
    return ids;
  } finally {
    await client.end();
  }
}

test('the library: pages of 25, the list scrolling in its own box, a link opening to its page', async ({
  page,
}, testInfo) => {
  const f = fixtureFor(testInfo.project.name);
  await seed(f);
  const backlog = await seedBacklog(f);
  await signIn(page, f);
  // Short enough that a page of rows is taller than the box it scrolls in.
  await page.setViewportSize({ width: 1280, height: 640 });

  await page.goto('/chat/artifacts');
  const list = page.getByRole('region', { name: 'Artifacts' });
  const pager = list.getByRole('navigation', { name: 'Pages' });
  await expect(pager.getByText('1–25 of 34')).toBeVisible();
  await expect(pager.getByText('Page 1 of 2')).toBeVisible();
  await expect(pager.getByRole('button', { name: 'Previous page' })).toBeDisabled();
  await expect(list.getByText('backlog-22.txt')).toBeAttached();
  await expect(list.getByText('backlog-23.txt')).toHaveCount(0);
  await expect(list.getByText('vendor-sdk-manual.txt')).toHaveCount(0);

  // The rows scroll inside the list; the filters and the pager stay where they are.
  const rows = list.getByRole('list');
  const box = await rows.evaluate((element) => ({
    scrolls: element.scrollHeight > element.clientHeight,
    overflow: getComputedStyle(element).overflowY,
  }));
  expect(box.scrolls).toBe(true);
  expect(box.overflow).toBe('auto');
  await expect(pager).toBeInViewport();
  await expect(page.getByRole('group', { name: 'Show' })).toBeInViewport();
  const pageScroll = await page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight
  );
  expect(pageScroll).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'artifacts-17-paged');

  // The second page: the oldest eight and the shared one, and no further;
  // the URL says which page, so it is a link.
  await pager.getByRole('button', { name: 'Next page' }).click();
  await expect(pager.getByText('26–34 of 34')).toBeVisible();
  await expect(page).toHaveURL(/page=2/);
  await expect(list.getByText('backlog-23.txt')).toBeVisible();
  await expect(list.getByText('backlog-30.txt')).toBeVisible();
  await expect(list.getByText('vendor-sdk-manual.txt')).toBeVisible();
  await expect(list.getByText('backlog-22.txt')).toHaveCount(0);
  await expect(pager.getByRole('button', { name: 'Next page' })).toBeDisabled();
  await shot(page, testInfo, 'artifacts-18-paged-second');

  // A search starts over on the first page of what it finds: a word in a
  // name (a substring), or in the summary and keywords the model wrote.
  const search = page.getByLabel('Search artifacts');
  await search.fill('backlog-2');
  await expect(pager.getByText('1–10 of 10')).toBeVisible();
  await expect(pager.getByRole('button', { name: 'Next page' })).toHaveCount(0);
  await search.fill('monetary rounding');
  await expect(list.getByText('schema-guide.md')).toBeVisible();
  await expect(pager.getByText('1–1 of 1')).toBeVisible();
  await search.fill('jitter');
  await expect(list.getByText('vendor-sdk-manual.txt')).toBeVisible();
  await expect(pager.getByText('1–1 of 1')).toBeVisible();
  // (The sentence about summaries follows the organization's digest
  // switch, which another test flips; the first words are the assertion.)
  await search.fill('zzzz-nothing');
  await expect(list.getByText(/^Nothing matches\./)).toBeVisible();
  await shot(page, testInfo, 'artifacts-20-search-empty');
  await search.fill('');
  await expect(pager.getByText('Page 1 of 2')).toBeVisible();

  // The link a notification carries opens to the page its file is on.
  await page.goto(`/chat/artifacts?artifact=${backlog[29]}`);
  await expect(pager.getByText('Page 2 of 2')).toBeVisible();
  const details = page.getByRole('complementary', { name: 'Selected artifact' });
  await expect(details.getByRole('link', { name: 'backlog-30.txt' })).toBeVisible();
  await expect(list.getByRole('button', { name: /backlog-30\.txt/ })).toHaveAttribute(
    'aria-current',
    'true'
  );
});

test('the library: a real upload lands, reads back, and is attached from the card', async ({
  page,
}, testInfo) => {
  const f = fixtureFor(testInfo.project.name);
  await seed(f);
  await signIn(page, f);

  // Digests are off by default — a file's text goes to a model only when
  // the organization says so. On, through the switch (shared by every
  // project in a run, so only flipped when it is off).
  await page.goto('/admin/settings');
  const digestSwitch = page.getByRole('switch', {
    name: 'Summarize artifacts with the default model',
  });
  await expect(digestSwitch).toBeVisible();
  if ((await digestSwitch.getAttribute('aria-checked')) !== 'true') {
    await digestSwitch.click();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
  }
  await shot(page, testInfo, 'artifacts-21-digest-switch');

  // No mock: the bytes go to the blob store's local backend (the Playwright
  // config points the dev server at it), the text is extracted, the row
  // appears, and the download serves the same bytes back.
  await page.goto('/chat/artifacts');
  await page.getByLabel('Upload artifacts').setInputFiles({
    name: 'api-style-guide.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# API style guide\n\nMoney fields are snake_case and numeric.\n'),
  });
  const list = page.getByRole('region', { name: 'Artifacts' });
  await expect(list.getByText('api-style-guide.md')).toBeVisible(COLD);
  // The upload stays on the table: the page does not turn to the file.
  await expect(page).toHaveURL(/\/chat\/artifacts(\?.*)?$/);
  await list.getByText('api-style-guide.md').click();
  const details = page.getByRole('complementary', { name: 'Selected artifact' });
  await expect(details.getByText('Ready to read')).toBeVisible();
  const href = await details.getByRole('link', { name: 'api-style-guide.md' }).getAttribute('href');
  expect(href).toMatch(/\/api\/chat\/attachments\//);
  const served = await page.request.get(href!);
  expect(served.ok()).toBe(true);
  expect(await served.text()).toContain('Money fields are snake_case');

  if (BLOBS) {
    // At rest the store holds the file sealed under the artifact's key:
    // the envelope's magic in front, none of the text anywhere in it.
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    let blobKey: string;
    try {
      const { rows } = await client.query<{ blob_key: string }>(
        `SELECT blob_key FROM artifacts WHERE owner_subject = $1 AND filename = 'api-style-guide.md'`,
        [f.subject]
      );
      blobKey = rows[0]!.blob_key;
    } finally {
      await client.end();
    }
    const atRest = await storedBytes(blobKey);
    expect(atRest.subarray(0, SEALED_MAGIC.byteLength).equals(SEALED_MAGIC)).toBe(true);
    expect(atRest.includes(Buffer.from('snake_case'))).toBe(false);

    // A file stored in the clear before this build reads as it did, and the
    // first read seals it in place; the second read opens what was sealed.
    const before = await storedBytes(`chat/e2e/${f.csvId}`);
    expect(before.toString()).toBe(CSV_TEXT);
    const legacy = await page.request.get(`/api/chat/attachments/${f.csvId}`);
    expect(legacy.ok()).toBe(true);
    expect(await legacy.text()).toBe(CSV_TEXT);
    const after = await storedBytes(`chat/e2e/${f.csvId}`);
    expect(after.subarray(0, SEALED_MAGIC.byteLength).equals(SEALED_MAGIC)).toBe(true);
    expect(after.includes(Buffer.from('10.00'))).toBe(false);
    const again = await page.request.get(`/api/chat/attachments/${f.csvId}`);
    expect(await again.text()).toBe(CSV_TEXT);
  }

  // The digest: asked of the org's default model (the stub) after the
  // upload's response, stored in the clear, shown, and searched.
  await expect
    .poll(async () => (await digestStatusOf(f.subject, 'api-style-guide.md'))?.status, COLD)
    .toBe('done');
  const uploaded = await digestStatusOf(f.subject, 'api-style-guide.md');
  await page.goto(`/chat/artifacts?artifact=${uploaded!.id}`);
  const about = details.getByRole('region', { name: 'About this file' });
  await expect(about.getByText('Stub summary: # API style guide')).toBeVisible();
  await expect(
    about.getByRole('list', { name: 'Keywords' }).getByRole('button', { name: 'money' })
  ).toBeVisible();
  await page.getByLabel('Search artifacts').fill('money fields');
  await expect(list.getByText('api-style-guide.md')).toBeVisible();
  await expect(list.getByText('schema-guide.md')).toBeHidden();
  await page.getByLabel('Search artifacts').fill('');
  await expect(list.getByText('schema-guide.md')).toBeVisible();

  // Hover: the controls explain themselves, in an element a screenshot keeps.
  await details.getByRole('button', { name: 'Rename' }).hover();
  await shot(page, testInfo, 'artifacts-10-hover-details');

  // Attach it from the project's card, as Always: its text is short.
  await page.goto(`/chat/projects/${f.projectId}`);
  const card = page.getByRole('region', { name: 'Artifacts' });
  await card.getByRole('button', { name: 'Attach from library…' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByLabel('Attach api-style-guide.md').check();
  await picker
    .getByRole('radiogroup', { name: /How .* uses api-style-guide\.md/ })
    .getByRole('radio', { name: 'Always' })
    .click();
  await picker.getByRole('button', { name: /^Attach 1$/ }).click();
  await expect(card.getByText('api-style-guide.md')).toBeVisible();
  await expect(card.getByText(/1 file · \d+ tokens of 24k tokens per turn/)).toBeVisible();
  await card
    .getByRole('radiogroup', { name: "How this project's chats use api-style-guide.md" })
    .getByRole('radio', { name: 'On demand' })
    .hover();
  await shot(page, testInfo, 'artifacts-11-hover-mode');
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
  const remembered = page.getByRole('button', { name: /Dropped files go to .* artifacts/ });
  await expect(remembered).toBeVisible();
  await expect(page.getByRole('button', { name: 'Attach a file' })).toBeVisible();
  await remembered.hover();
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
  await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible();
  await shot(page, testInfo, 'artifacts-07-phone-library');

  // A card opens the file's details over the list — the list goes, a
  // back button brings it back — the way the code pane opens a file.
  await list.getByRole('button', { name: /schema-guide\.md/ }).click();
  const details = page.getByRole('complementary', { name: 'Selected artifact' });
  await expect(details).toBeVisible();
  await expect(page.getByRole('heading', { name: 'schema-guide.md' })).toBeVisible();
  await expect(list).toHaveCount(0);
  await expect(details.getByRole('button', { name: 'Close details' })).toHaveCount(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'artifacts-19-phone-details');
  await page.getByRole('button', { name: 'Back to artifacts' }).click();
  await expect(list.getByText('schema-guide.md')).toBeVisible();
  await expect(details).toHaveCount(0);
  await list.getByRole('button', { name: /schema-guide\.md/ }).click();
  await expect(details).toBeVisible();

  // The owner's dialogs at phone width: share, then delete with its impact.
  await details.getByRole('button', { name: 'Share…' }).click();
  await expect(page.getByRole('dialog').getByText(/Sharing lets a person use it/)).toBeVisible();
  await shot(page, testInfo, 'artifacts-12-phone-share');
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await details.getByRole('button', { name: 'Delete' }).click();
  await expect(
    page.getByRole('dialog').getByText('Deleting removes the file for everyone')
  ).toBeVisible();
  await shot(page, testInfo, 'artifacts-13-phone-delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  await page.goto(`/chat/projects/${f.projectId}`);
  const card = page.getByRole('region', { name: 'Artifacts' });
  await expect(card.getByText('schema-guide.md')).toBeVisible();
  await expect(card.getByRole('radio', { name: 'On demand' })).toBeVisible();
  await shot(page, testInfo, 'artifacts-08-phone-project');
  await card.getByRole('button', { name: 'Attach from library…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Generated in chats' }).click();
  await expect(page.getByRole('dialog').getByText('rounding-analysis.md')).toBeVisible();
  await shot(page, testInfo, 'artifacts-14-phone-picker');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  // The chooser in a project chat, and the remembered control (the glyph alone here).
  await page.goto(`/chat/${f.chatId}`);
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
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
  await shot(page, testInfo, 'artifacts-15-phone-chooser');
  await chooser.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('link', { name: 'retry-policy.md' })).toBeVisible(COLD);
  const remembered = page.getByRole('button', { name: /Dropped files go to .* artifacts/ });
  await expect(remembered).toBeVisible();
  const row = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(row).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'artifacts-16-phone-remembered');
});

test('the library: several files are ticked, deleted with the impact warned, or added to a project', async ({
  page,
}, testInfo) => {
  const f = fixtureFor(testInfo.project.name);
  await seed(f);
  await signIn(page, f);

  await page.goto('/chat/artifacts');
  const list = page.getByRole('region', { name: 'Artifacts' });
  await expect(list.getByText('schema-guide.md')).toBeVisible(COLD);
  // No checkmarks until select mode is on; in it, a click on the row ticks
  // it and leaves the details alone.
  await expect(page.getByRole('checkbox', { name: 'Select schema-guide.md' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await list.getByText('schema-guide.md').click();
  await expect(page).not.toHaveURL(/artifact=/);
  await page.getByRole('checkbox', { name: 'Select schema-guide.md' }).check();
  await page.getByRole('checkbox', { name: 'Select rounding-analysis.md' }).check();
  const toolbar = page.getByRole('toolbar', { name: 'Selected artifacts' });
  await expect(toolbar.getByText('2 selected')).toBeVisible();

  // Delete: the warning names the project that loses schema-guide.md.
  await toolbar.getByRole('button', { name: 'Delete…' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Delete 2 files?')).toBeVisible();
  await expect(dialog.getByText('Working out who uses them…')).toHaveCount(0, COLD);
  await expect(dialog.getByText(`schema-guide.md: ${f.projectName}`)).toBeVisible();
  await shot(page, testInfo, 'artifacts-bulk-06-delete-warning');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  // Add to project: only the file the project does not hold yet is added.
  await toolbar.getByRole('button', { name: 'Add to project…' }).click();
  await expect(dialog.getByText('1 will be added.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add 1' }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  const row = page.locator('[data-artifact]', { hasText: 'rounding-analysis.md' });
  await expect(row.getByText(f.projectName)).toBeVisible();
});

test('a project page: pressing remove again after the server has answered takes one request and shows no error', async ({
  page,
}, testInfo) => {
  const f = fixtureFor(testInfo.project.name);
  await seed(f);
  await signIn(page, f);

  await page.goto(`/chat/projects/${f.projectId}`);
  const card = page.getByRole('region', { name: 'Artifacts' });
  await expect(card.getByText('schema-guide.md')).toBeVisible(COLD);
  const detaches: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && request.url().includes('/artifacts/')) {
      detaches.push(request.method());
    }
  });
  const remove = card.getByRole('button', {
    name: `Remove schema-guide.md from ${f.projectName}`,
  });
  const answered = page.waitForResponse(
    (response) => response.request().method() !== 'GET' && response.url().includes('/artifacts/')
  );
  await remove.click();
  await answered;
  // The second press: the row may still be on screen while the page refreshes.
  if (await remove.isVisible()) await remove.click({ force: true });
  await expect(card.getByText('schema-guide.md')).toBeHidden();
  await expect(card.getByRole('alert')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  expect(detaches).toHaveLength(1);
});

/**
 * Points OCR at the sandbox stub's Mistral route, with a key sealed the way
 * the app seals it. The connector's config is read through a cache for a
 * minute, so a spec that needs it right away asks for it again.
 */
async function mistralStubConfigured(): Promise<void> {
  const keyring = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyring.ok) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO connector_configs (connector, enabled, encrypted_secrets, settings)
       VALUES ('mistral-ocr', true, $1, $2::jsonb)
       ON CONFLICT (connector) DO UPDATE
         SET enabled = true, encrypted_secrets = EXCLUDED.encrypted_secrets, settings = EXCLUDED.settings`,
      [
        encrypt(JSON.stringify({ apiKey: 'e2e-ocr-key' }), keyring.val),
        JSON.stringify({
          endpoint: 'http://127.0.0.1:8092/mistral/v1/ocr',
          model: 'mistral-ocr-4-0',
        }),
      ]
    );
  } finally {
    await client.end();
  }
}

/** A scan the library holds as needs_ocr. Its text says SLOW, so the stub holds the read for a few seconds. */
async function uploadScan(page: Page, name: string): Promise<void> {
  await page.getByLabel('Upload artifacts').setInputFiles({
    name,
    mimeType: 'image/png',
    buffer: Buffer.from(`SLOW ${name} invoice\n`),
  });
  await expect(page.getByRole('region', { name: 'Artifacts' }).getByText(name)).toBeVisible(COLD);
}

test('the library: OCR is asked for on a scan, its progress and estimate show while it runs, and the summary makes it searchable', async ({
  page,
}, testInfo) => {
  const f = fixtureFor(testInfo.project.name);
  await seed(f);
  await signIn(page, f);
  await mistralStubConfigured();

  // Summaries on, as the upload test turns them: search reads them.
  await page.goto('/admin/settings');
  const digestSwitch = page.getByRole('switch', {
    name: 'Summarize artifacts with the default model',
  });
  await expect(digestSwitch).toBeVisible();
  if ((await digestSwitch.getAttribute('aria-checked')) !== 'true') {
    await digestSwitch.click();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
  }

  await page.goto('/chat/artifacts');
  const list = page.getByRole('region', { name: 'Artifacts' });
  const details = page.getByRole('complementary', { name: 'Selected artifact' });

  // Three scans read in a bulk run give the estimate its finished reads.
  for (const name of ['scan-a.png', 'scan-b.png', 'scan-c.png']) {
    await uploadScan(page, name);
  }
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  for (const name of ['scan-a.png', 'scan-b.png', 'scan-c.png']) {
    await page.getByRole('checkbox', { name: `Select ${name}` }).check();
  }
  const toolbar = page.getByRole('toolbar', { name: 'Selected artifacts' });
  await shot(page, testInfo, 'ocr-bulk-06-toolbar-below-list');
  await toolbar.getByRole('button', { name: 'Run OCR' }).click();
  await expect(list.getByText('OCR running').first()).toBeVisible(COLD);
  await expect(list.getByText('OCR running')).toHaveCount(0, { timeout: 60_000 });
  await page.getByRole('button', { name: 'Done selecting' }).click();

  // A fourth, read from its details: while it runs, the page shows how long
  // it has been, and how long the three finished reads say it has left.
  await uploadScan(page, 'scan-d.png');
  await uploadScan(page, 'scan-e.png');
  await list.getByText('scan-e.png').click();
  await expect(details.getByRole('button', { name: 'Run OCR' })).toBeVisible();
  await shot(page, testInfo, 'ocr-00-offered-in-details');
  await list.getByText('scan-d.png').click();
  await details.getByRole('button', { name: 'Run OCR' }).click();
  await expect(details.getByText(/Reading the scan · \d+ s so far/)).toBeVisible(COLD);
  await expect(details.getByText(/About \d+ s left, from \d+ similar files\./)).toBeVisible(COLD);
  await expect(details.getByRole('progressbar', { name: 'OCR progress' })).toBeVisible();
  await shot(page, testInfo, 'ocr-01-running-with-estimate');

  // Done: the pages it read, the summary the model wrote, and search finds it.
  await expect(details.getByText('Read 2 pages by OCR.')).toBeVisible({ timeout: 60_000 });
  await expect(details.getByText(/Stub summary/)).toBeVisible(COLD);
  await shot(page, testInfo, 'ocr-02-done-with-summary');

  await page.getByLabel('Search artifacts').fill('invoice');
  await expect(list.locator('[data-artifact]', { hasText: 'scan-d.png' })).toBeVisible();
  // scan-e was never read, so nothing about it is in the index.
  await expect(list.locator('[data-artifact]', { hasText: 'scan-e.png' })).toHaveCount(0);
  await shot(page, testInfo, 'ocr-03-search-finds-the-scan');

  // Phone width: the offer opens over the list, and the page does not scroll sideways.
  await page.setViewportSize(MOBILE_VIEWPORT);
  // Reloaded, so no details from the desktop layout cover the list.
  await page.goto('/chat/artifacts');
  await page.getByLabel('Search artifacts').fill('');
  await page
    .locator('[data-artifact]', { hasText: 'scan-e.png' })
    .getByRole('button')
    .first()
    .click();
  await expect(page.getByRole('button', { name: 'Run OCR' })).toBeVisible();
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(overflows).toBe(false);
  await shot(page, testInfo, 'ocr-04-phone-offer');
});

test('the library: a photo with no text is described from the picture, OCR finds nothing to read in it, and the usage counts it under Documents', async ({
  page,
}, testInfo) => {
  const f = fixtureFor(testInfo.project.name);
  await seed(f);
  await signIn(page, f);
  await mistralStubConfigured();

  // Summaries and descriptions on, as the other specs turn them.
  await page.goto('/admin/settings');
  const digestSwitch = page.getByRole('switch', {
    name: 'Summarize artifacts with the default model',
  });
  await expect(digestSwitch).toBeVisible();
  if ((await digestSwitch.getAttribute('aria-checked')) !== 'true') {
    await digestSwitch.click();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
  }

  await page.goto('/chat/artifacts');
  const list = page.getByRole('region', { name: 'Artifacts' });
  const details = page.getByRole('complementary', { name: 'Selected artifact' });
  await page.getByLabel('Upload artifacts').setInputFiles({
    name: 'car-street.png',
    mimeType: 'image/png',
    buffer: Buffer.from('NOTEXT a red car on a street\n'),
  });
  await expect(list.getByText('car-street.png')).toBeVisible(COLD);
  await list.getByText('car-street.png').click();

  // Described from the picture itself: no text, and not waiting for OCR.
  await expect(
    details.getByText(
      'A red car on a street beside a beach, with modern buildings along the shoreline.'
    )
  ).toBeVisible(COLD);
  await expect(details.getByText('Waiting for OCR')).toHaveCount(0);
  await shot(page, testInfo, 'documents-01-photo-described');

  // OCR asked for: it reads nothing, which is a result, and the description stays.
  await details.getByRole('button', { name: 'Run OCR' }).click();
  await expect(details.getByText('No text', { exact: true })).toBeVisible(COLD);
  await expect(
    details.getByText(
      'A red car on a street beside a beach, with modern buildings along the shoreline.'
    )
  ).toBeVisible();
  await shot(page, testInfo, 'documents-02-ocr-finds-no-text');

  // The uploader's usage: one picture described, and the pages OCR read.
  await page.goto('/utilization');
  const card = page.getByTestId('document-usage-card');
  await expect(card).toBeVisible(COLD);
  await expect(page.getByTestId('document-usage-summaries')).toHaveText('1');
  await expect(page.getByTestId('document-usage-pages')).toHaveText('2');
  await expect(card.getByText(/12 tokens in/)).toBeVisible();
  // The Documents row in the breakdown says what the work was, not just its tokens.
  await expect(page.getByText(/1 OCR read, 2 pages · 1 picture described/)).toBeVisible();
  await shot(page, testInfo, 'documents-03-usage-documents-card');
});
