/**
 * Artifacts, end to end in a browser (docs/artifacts-design.md): the
 * library page with its filters and details panel; rename, share and
 * delete-with-impact on one file; the list paged and scrolling in its own
 * box, the search finding a file by its name or by the digest (summary
 * and keywords) the model wrote for it, a link opening to the page its
 * file is on; a project page's Artifacts card with the Always / On demand
 * switch and attaching from the library; the composer's "where should it
 * go?" chooser in a project chat; ticking several files in the library to
 * delete them (the impact warned first) or add them to a project; a second
 * press on a project's remove button after the server has answered, which
 * must not reach it again; OCR on scans; and, at phone width, the cards
 * that open a file's details over the list, a back button to return.
 *
 * Everything is staged the way people make it: uploads through the
 * attachments route (into the blob store's local backend), a file the
 * model writes in a real chat turn, a colleague (a second person) who
 * uploads and shares, the project and its references through their
 * routes. Digests come from the org's default model — the stand-in, put on
 * the roster as the default and left there — with the summary switch on;
 * a staged file's own text scripts the digest it gets
 * ([[stub-script]], e2e/llm-stub.mjs). OCR is the sandbox stub's Mistral
 * route, configured through the admin connector route and left on.
 *
 * Runs on the pinned Chromium; "phone" is a resized viewport.
 */

import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { LLM_STUB_PICTURE, SANDBOX_STUB_URL } from './constants';
import { createPerson, type Person } from './support/person';
import { addStubModel, removeModel, scripted, stubScript, toolStep } from './support/stub-model';
import { createChat, send } from './support/chat';

// Staging turns on org-wide switches (summaries, OCR, the default model).
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
/** The memory server's local blob store (playwright.config.ts), unless pointed elsewhere. */
const BLOBS =
  (process.env.BLOB_STORE_PROVIDER ?? 'local') === 'local'
    ? (process.env.BLOB_STORE_LOCAL_DIR ?? path.join(RESULTS, 'blobs'))
    : null;
const SEALED_MAGIC = Buffer.from('renc2b\0', 'latin1');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** A first visit compiles the page on the dev server; a real upload extracts text. */
const COLD = { timeout: 30_000 };
/** The org's default model, the stand-in: one of its kind, left on the roster. */
const DEFAULT_MODEL_LABEL = 'Default stub model (e2e)';

/** A digest the model is scripted to write for the file whose text carries it. */
const digest = (summary: string, keywords: string[]) =>
  stubScript([
    { oneShot: true, tools: [{ name: 'artifact_digest', input: { summary, keywords } }] },
  ]);

const GUIDE_TEXT =
  '# Postgres schema guide\n\nMonetary columns are numeric(12,4). Round half to even at the boundary, never in storage.\n\n' +
  digest('A Postgres schema guide: how monetary columns are typed and where rounding happens.', [
    'postgres',
    'schema',
    'monetary columns',
    'rounding',
    'numeric',
  ]);
const REPORT_TEXT = '# Rounding analysis\n\nThree call sites round per line; one rounds once.\n';
const MANUAL_TEXT =
  'Vendor SDK manual. Retries are exponential with jitter.\n\n' +
  digest('The vendor SDK manual: retries are exponential with jitter.', [
    'vendor sdk',
    'retries',
    'jitter',
  ]);
const CSV_TEXT = 'id,amount\n1,10.00\n';

function field(body: unknown, ...names: string[]): unknown {
  let value = body;
  for (const name of names) {
    value = typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;
  }
  return value;
}

/** A file put where the composer or the library's Upload puts it; answers its id. */
async function upload(
  request: APIRequestContext,
  file: { name: string; type: string; body: string | Buffer },
  home: Record<string, string> = {},
  headers: Record<string, string> = {}
): Promise<string> {
  const query = new URLSearchParams({ filename: file.name, contentType: file.type, ...home });
  const response = await request.put(`/api/chat/attachments?${query.toString()}`, {
    headers: { ...headers, 'content-type': file.type },
    data: Buffer.from(file.body),
  });
  expect(response.status(), await response.text()).toBe(201);
  const id = field(await response.json(), 'attachment', 'id');
  if (typeof id !== 'string') throw new Error(`no attachment id for ${file.name}`);
  return id;
}

/**
 * Summaries on, OCR configured, and the stand-in the org's default model,
 * written the same each time and left on (other tests rely on them side by
 * side; one that makes a default of its own and deletes it leaves the org
 * without one, so this checks on every call). It then proves an upload
 * really is summarized and a scan read — by a person of its own, so no
 * test's library or usage counts the probe — and goes round again if
 * another worker was swapping the default model at that moment (the
 * suite reads settings and the roster afresh: RENKEI_CONFIG_CACHE_TTL_MS).
 * Answers the model's id.
 */
async function digestsReady(request: APIRequestContext): Promise<string> {
  const operator = await createPerson(request, {
    roles: ['renkei-user', 'renkei-operator'],
    displayName: 'Artifacts operator',
  });
  const headers = operator.headers;
  const settings = await request.put('/api/admin/org-settings', {
    headers,
    data: { artifactDigestEnabled: true },
  });
  expect(settings.ok(), await settings.text()).toBe(true);
  const ocr = await request.put('/api/admin/connectors/mistral-ocr', {
    headers,
    data: {
      endpoint: `${SANDBOX_STUB_URL}/mistral/v1/ocr`,
      model: 'mistral-ocr-4-0',
      apiKey: 'e2e-ocr-key',
      enabled: true,
    },
  });
  expect(ocr.ok(), await ocr.text()).toBe(true);
  let modelId = '';
  await expect(async () => {
    const roster = await request.get('/api/admin/llm-models', { headers });
    const { models }: { models: { id: string; label: string; isDefault: boolean }[] } =
      await roster.json();
    const ours = models.filter((model) => model.label === DEFAULT_MODEL_LABEL);
    const current = ours.find((model) => model.isDefault);
    // A copy left behind when two workers added it at once: never the default,
    // so taking it away moves nothing. (The request context carries the
    // operator's cookie too: signing in set it.)
    for (const stale of ours) if (!stale.isDefault) await removeModel(request, stale.id);
    // Added only when no copy is the default: making another default would
    // move the default under a digest another test is waiting on (the suite
    // reads the roster afresh on every request).
    modelId =
      current?.id ??
      (await addStubModel(request, 'default', {
        label: DEFAULT_MODEL_LABEL,
        isDefault: true,
      }));
    const probe = await upload(
      request,
      { name: 'probe.md', type: 'text/markdown', body: '# Probe\n\nA probe.\n' },
      {},
      headers
    );
    await expect
      .poll(
        async () =>
          field(
            await (await request.get(`/api/chat/artifacts/${probe}`, { headers })).json(),
            'artifact',
            'summary'
          ),
        { timeout: 5_000 }
      )
      .toBe('Stub summary: # Probe');
    const scan = await upload(
      request,
      { name: 'probe.png', type: 'image/png', body: 'probe scan\n' },
      {},
      headers
    );
    const read = await request.post(`/api/chat/artifacts/${scan}/ocr`, { headers, data: {} });
    expect(read.status()).not.toBe(503);
  }).toPass({ timeout: 60_000, intervals: [500] });
  return modelId;
}

interface Staged {
  modelId: string;
  projectId: string;
  projectName: string;
  chatId: string;
  plainChatId: string;
  csvId: string;
  guideId: string;
  reportId: string;
  manualId: string;
  friend: Person;
  friendEmail: string;
  /** By n (1–30), when asked for: older than the rest. */
  backlog: string[];
}

/**
 * The person's library: an upload kept by a project, a file the model
 * wrote in that project's chat, a file dropped into a plain chat, and a
 * colleague's file shared with them — and, with `backlog`, thirty older
 * uploads before them all.
 */
async function stage(
  page: Page,
  request: APIRequestContext,
  person: Person,
  testInfo: TestInfo,
  options: { backlog?: boolean } = {}
): Promise<Staged> {
  const modelId = await digestsReady(request);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const backlog: string[] = [];
  if (options.backlog) {
    // Oldest first, so backlog-01 is the newest of them.
    for (let n = 30; n >= 1; n -= 1) {
      const name = `backlog-${String(n).padStart(2, '0')}.txt`;
      backlog[n] = await upload(page.request, { name, type: 'text/plain', body: 'backlog note' });
    }
  }
  const projectName = `Billing API (${tag})`;
  const project = await page.request.post('/api/chat/projects', {
    data: { name: projectName, description: 'Invoices and refunds.' },
  });
  expect(project.status(), await project.text()).toBe(201);
  const { projectId } = await project.json();

  const guideId = await upload(page.request, {
    name: 'schema-guide.md',
    type: 'text/markdown',
    body: GUIDE_TEXT,
  });
  const attached = await page.request.post(`/api/chat/projects/${projectId}/artifacts`, {
    data: { artifactId: guideId, mode: 'on_demand' },
  });
  expect(attached.ok(), await attached.text()).toBe(true);

  const chatId = await createChat(page.request, {
    llmModelId: modelId,
    projectId,
    title: 'Fix invoice rounding',
  });
  const wrote = await send(
    page.request,
    chatId,
    scripted('Write up the rounding analysis.', [
      toolStep('chat_write_file', { filename: 'rounding-analysis.md', content: REPORT_TEXT }),
      { text: 'Written.' },
    ]),
    modelId,
    { allow: true }
  );
  const reportId = wrote.chat.artifacts.find(
    (file) => file.filename === 'rounding-analysis.md'
  )?.id;
  if (!reportId) throw new Error(`no report in ${JSON.stringify(wrote.chat.artifacts)}`);

  const plainChatId = await createChat(page.request, {
    llmModelId: modelId,
    title: 'Reconcile March invoices',
  });
  const csvId = await upload(
    page.request,
    { name: 'march-invoices.csv', type: 'text/csv', body: CSV_TEXT },
    { chatId: plainChatId }
  );

  const friendEmail = `priya-${tag}@example.test`;
  const friend = await createPerson(request, { displayName: 'Priya Friend', email: friendEmail });
  const manualId = await upload(
    request,
    { name: 'vendor-sdk-manual.txt', type: 'text/plain', body: MANUAL_TEXT },
    {},
    friend.headers
  );
  const shared = await request.post(`/api/chat/artifacts/${manualId}/grants`, {
    headers: friend.headers,
    data: { granteeSubject: person.subject, role: 'viewer', expiresAt: null },
  });
  expect(shared.ok(), await shared.text()).toBe(true);
  // The digests the staged files script land after their uploads answer.
  await expect
    .poll(async () => {
      const library = await (await page.request.get('/api/chat/artifacts?all=1')).json();
      const items: { id: string; digestStatus: string }[] = library.artifacts;
      return [guideId, manualId].every((id) =>
        items.some((item) => item.id === id && item.digestStatus === 'done')
      );
    }, COLD)
    .toBe(true);
  return {
    modelId,
    projectId,
    projectName,
    chatId,
    plainChatId,
    csvId,
    guideId,
    reportId,
    manualId,
    friend,
    friendEmail,
    backlog,
  };
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

/** The digest's state for one of the person's files, as the library reads it. */
async function digestStatusOf(
  page: Page,
  filename: string
): Promise<{ id: string; status: string } | null> {
  const library = await (await page.request.get('/api/chat/artifacts?all=1')).json();
  const items: { id: string; filename: string; digestStatus: string }[] = library.artifacts;
  const item = items.find((entry) => entry.filename === filename);
  return item ? { id: item.id, status: item.digestStatus } : null;
}

/** The bytes the local store holds for one artifact (its key ends in the artifact's id). */
async function storedBytes(artifactId: string): Promise<Buffer> {
  if (!BLOBS) throw new Error('no local blob store to read');
  const files = await readdir(BLOBS, { recursive: true });
  const found = files.find((file) => file.endsWith(artifactId));
  if (!found) throw new Error(`no blob for ${artifactId} under ${BLOBS}`);
  return readFile(path.join(BLOBS, found));
}

test('the library: filters, details, rename, share, delete with its impact', async ({
  page,
  request,
  person,
}, testInfo) => {
  const f = await stage(page, request, person, testInfo);

  await page.goto('/chat/artifacts');
  await expect(page.getByRole('heading', { name: 'Artifacts' })).toBeVisible(COLD);
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
  await expect(page.getByLabel('Search artifacts').filter({ visible: true })).toHaveValue(
    'rounding'
  );
  await expect(list.getByText('rounding-analysis.md')).toBeVisible();
  await expect(list.getByText('schema-guide.md')).toBeVisible();
  await expect(list.getByText('march-invoices.csv')).toBeHidden();
  await expect(page).toHaveURL(/q=rounding/);
  await page.getByLabel('Search artifacts').filter({ visible: true }).fill('');
  await expect(list.getByText('march-invoices.csv')).toBeVisible();

  await details.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('File name').fill('postgres-schema-guide.md');
  await page.getByRole('button', { name: 'Rename' }).last().click();
  await expect(list.getByText('postgres-schema-guide.md')).toBeVisible();

  // Share with a colleague: they get "use", never "edit".
  await details.getByRole('button', { name: 'Share…' }).click();
  const share = page.getByRole('dialog');
  await expect(share.getByText(/Sharing lets a person use it/)).toBeVisible();
  await share.getByPlaceholder('Name or email').fill(f.friendEmail);
  await share.getByRole('button', { name: f.friendEmail }).click();
  await share.getByRole('button', { name: 'Share', exact: true }).click();
  await expect(share.getByText('Priya Friend')).toBeVisible();
  await expect(share.getByText('use', { exact: true })).toBeVisible();
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

test('the library: pages of 25, the list scrolling in its own box, a link opening to its page', async ({
  page,
  request,
  person,
}, testInfo) => {
  test.slow();
  const f = await stage(page, request, person, testInfo, { backlog: true });
  // Short enough that a page of rows is taller than the box it scrolls in.
  await page.setViewportSize({ width: 1280, height: 640 });

  await page.goto('/chat/artifacts');
  const list = page.getByRole('region', { name: 'Artifacts' });
  const pager = list.getByRole('navigation', { name: 'Pages' });
  await expect(pager.getByText('1–25 of 34')).toBeVisible(COLD);
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
  const search = page.getByLabel('Search artifacts').filter({ visible: true });
  await search.fill('backlog-2');
  await expect(pager.getByText('1–10 of 10')).toBeVisible();
  await expect(pager.getByRole('button', { name: 'Next page' })).toHaveCount(0);
  await search.fill('monetary rounding');
  await expect(list.getByText('schema-guide.md')).toBeVisible();
  await expect(pager.getByText('1–1 of 1')).toBeVisible();
  await search.fill('jitter');
  await expect(list.getByText('vendor-sdk-manual.txt')).toBeVisible();
  await expect(pager.getByText('1–1 of 1')).toBeVisible();
  await search.fill('zzzz-nothing');
  await expect(list.getByText(/^Nothing matches\./)).toBeVisible();
  await shot(page, testInfo, 'artifacts-20-search-empty');
  await search.fill('');
  await expect(pager.getByText('Page 1 of 2')).toBeVisible();

  // The link a notification carries opens to the page its file is on.
  await page.goto(`/chat/artifacts?artifact=${f.backlog[30]}`);
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
  request,
  person,
}, testInfo) => {
  const f = await stage(page, request, person, testInfo);

  // Digests are off by default — a file's text goes to a model only when
  // the organization says so. The switch, as an operator sees it: staging
  // turned it on, and the page reads the settings afresh in the suite
  // (RENKEI_CONFIG_CACHE_TTL_MS=0); were it off, it is turned on here, as
  // an operator would.
  await page.goto('/admin/settings');
  const digestSwitch = page.getByRole('switch', {
    name: 'Summarize artifacts with the default model',
  });
  await expect(digestSwitch).toBeVisible(COLD);
  if ((await digestSwitch.getAttribute('aria-checked')) !== 'true') {
    await digestSwitch.click();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await digestsReady(request);
  }
  await expect(digestSwitch).toHaveAttribute('aria-checked', 'true');
  await shot(page, testInfo, 'artifacts-21-digest-switch');

  // The bytes go to the blob store's local backend, the text is extracted,
  // the row appears, and the download serves the same bytes back.
  await page.goto('/chat/artifacts');
  await page
    .getByRole('main')
    .getByLabel('Upload artifacts')
    .setInputFiles({
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
  const href =
    (await details.getByRole('link', { name: 'api-style-guide.md' }).getAttribute('href')) ?? '';
  expect(href).toMatch(/\/api\/chat\/attachments\//);
  const served = await page.request.get(href);
  expect(served.ok()).toBe(true);
  expect(await served.text()).toContain('Money fields are snake_case');

  // The digest: asked of the org's default model after the upload's
  // response, stored in the clear, shown, and searched.
  await expect
    .poll(async () => (await digestStatusOf(page, 'api-style-guide.md'))?.status, COLD)
    .toBe('done');
  const uploaded = await digestStatusOf(page, 'api-style-guide.md');
  if (BLOBS && uploaded) {
    // At rest the store holds the file sealed under the artifact's key:
    // the envelope's magic in front, none of the text anywhere in it.
    const atRest = await storedBytes(uploaded.id);
    expect(atRest.subarray(0, SEALED_MAGIC.byteLength).equals(SEALED_MAGIC)).toBe(true);
    expect(atRest.includes(Buffer.from('snake_case'))).toBe(false);
  }
  await page.goto(`/chat/artifacts?artifact=${uploaded?.id ?? ''}`);
  const about = details.getByRole('region', { name: 'About this file' });
  await expect(about.getByText('Stub summary: # API style guide')).toBeVisible();
  await expect(
    about.getByRole('list', { name: 'Keywords' }).getByRole('button', { name: 'money' })
  ).toBeVisible();
  await page.getByLabel('Search artifacts').filter({ visible: true }).fill('money fields');
  await expect(list.getByText('api-style-guide.md')).toBeVisible();
  await expect(list.getByText('schema-guide.md')).toBeHidden();
  await page.getByLabel('Search artifacts').filter({ visible: true }).fill('');
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
  request,
  person,
}, testInfo) => {
  const f = await stage(page, request, person, testInfo);

  await page.goto(`/chat/projects/${f.projectId}`);
  const card = page.getByRole('region', { name: 'Artifacts' });
  await expect(card.getByText('schema-guide.md')).toBeVisible(COLD);
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

/**
 * A file picked with the composer's paperclip, as a person picks one (a
 * built page can hold a hidden copy of the composer, so the button on
 * screen is the one pressed).
 */
async function attach(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer }
): Promise<void> {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach a file' }).filter({ visible: true }).click();
  await (await chooser).setFiles(file);
}

/** The composer's uploads, as the browser sends them (the query says where each goes). */
function watchUploads(page: Page): string[] {
  const uploads: string[] = [];
  page.on('request', (sent) => {
    const url = new URL(sent.url());
    if (sent.method() === 'PUT' && url.pathname === '/api/chat/attachments') {
      uploads.push(url.search);
    }
  });
  return uploads;
}

test('a project chat: a dropped file asks where it goes', async ({
  page,
  request,
  person,
}, testInfo) => {
  const f = await stage(page, request, person, testInfo);
  const uploads = watchUploads(page);

  await page.goto(`/chat/${f.chatId}`);
  await expect(page.getByLabel('Message').filter({ visible: true })).toBeVisible(COLD);
  await attach(page, {
    name: 'stripe-webhooks.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Stripe webhooks\n\nVerify every signature.\n'),
  });
  const chooser = page
    .getByRole('group', { name: 'Where should the files go?' })
    .filter({ visible: true });
  await expect(chooser.getByText('Where should stripe-webhooks.md go?')).toBeVisible();
  await expect(chooser.getByLabel(/Artifacts, attached to Billing API/)).toBeChecked();
  await shot(page, testInfo, 'artifacts-06-drop-chooser');
  await chooser.getByLabel(/This message only/).check();
  await chooser.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByText('stripe-webhooks.md')).toBeVisible();
  await expect.poll(() => uploads.length).toBe(1);
  expect(uploads[0]).not.toContain('keep=1');
  // Remembered: the next file goes the same way without asking.
  await attach(page, {
    name: 'second.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('second'),
  });
  await expect(chooser).toBeHidden();
  await expect.poll(() => uploads.length).toBe(2);
});

test('a project chat: Send answers the chooser, and the remembered choice can be changed', async ({
  page,
  request,
  person,
}, testInfo) => {
  const f = await stage(page, request, person, testInfo);
  const uploads = watchUploads(page);

  await page.goto(`/chat/${f.chatId}`);
  await expect(page.getByLabel('Message').filter({ visible: true })).toBeVisible(COLD);
  await attach(page, {
    name: 'retry-policy.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Retries\n\nExponential, with jitter.'),
  });
  const chooser = page
    .getByRole('group', { name: 'Where should the files go?' })
    .filter({ visible: true });
  await expect(chooser).toBeVisible();
  // No Add: the message is sent with the choice as it stands (the project).
  await page
    .getByRole('textbox', { name: 'Message' })
    .filter({ visible: true })
    .fill('Follow the retry policy.');
  await page.getByRole('button', { name: 'Send', exact: true }).filter({ visible: true }).click();
  await expect(chooser).toBeHidden();
  await expect.poll(() => uploads.length).toBe(1);
  expect(uploads[0]).toContain('keep=1');
  expect(uploads[0]).toContain(`projectId=${f.projectId}`);
  // The file is attached to the message that went out with it.
  await expect(page.getByRole('link', { name: 'retry-policy.md' })).toBeVisible(COLD);

  // The remembered choice shows beside the paperclip; clicking it asks again next time.
  const remembered = page
    .getByRole('button', { name: /Dropped files go to .* artifacts/ })
    .filter({ visible: true });
  await expect(remembered).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Attach a file' }).filter({ visible: true })
  ).toBeVisible();
  await remembered.hover();
  await shot(page, testInfo, 'artifacts-09-remembered-control');
  await remembered.click();
  await expect(remembered).toBeHidden();
  await attach(page, {
    name: 'again.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('again'),
  });
  await expect(chooser).toBeVisible();
});

test('phone: the library and the project card fit the viewport', async ({
  page,
  request,
  person,
}, testInfo) => {
  const f = await stage(page, request, person, testInfo);
  await page.setViewportSize(MOBILE_VIEWPORT);

  await page.goto('/chat/artifacts');
  const list = page.getByRole('region', { name: 'Artifacts' });
  await expect(list.getByText('schema-guide.md')).toBeVisible(COLD);
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
  await expect(card.getByText('schema-guide.md')).toBeVisible(COLD);
  await expect(card.getByRole('radio', { name: 'On demand' })).toBeVisible();
  await shot(page, testInfo, 'artifacts-08-phone-project');
  await card.getByRole('button', { name: 'Attach from library…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Generated in chats' }).click();
  await expect(page.getByRole('dialog').getByText('rounding-analysis.md')).toBeVisible();
  await shot(page, testInfo, 'artifacts-14-phone-picker');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();

  // The chooser in a project chat, and the remembered control (the glyph alone here).
  await page.goto(`/chat/${f.chatId}`);
  await expect(
    page.getByRole('textbox', { name: 'Message' }).filter({ visible: true })
  ).toBeVisible(COLD);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await attach(page, {
    name: 'retry-policy.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Retries\n\nExponential, with jitter.'),
  });
  const chooser = page
    .getByRole('group', { name: 'Where should the files go?' })
    .filter({ visible: true });
  await expect(chooser).toBeVisible();
  await shot(page, testInfo, 'artifacts-15-phone-chooser');
  await chooser.getByRole('button', { name: 'Add' }).click();
  await expect(page.getByRole('link', { name: 'retry-policy.md' })).toBeVisible(COLD);
  const remembered = page
    .getByRole('button', { name: /Dropped files go to .* artifacts/ })
    .filter({ visible: true });
  await expect(remembered).toBeVisible();
  const row = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(row).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'artifacts-16-phone-remembered');
});

test('the library: several files are ticked, deleted with the impact warned, or added to a project', async ({
  page,
  request,
  person,
}, testInfo) => {
  const f = await stage(page, request, person, testInfo);

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
  request,
  person,
}, testInfo) => {
  const f = await stage(page, request, person, testInfo);

  await page.goto(`/chat/projects/${f.projectId}`);
  const card = page.getByRole('region', { name: 'Artifacts' });
  await expect(card.getByText('schema-guide.md')).toBeVisible(COLD);
  const detaches: string[] = [];
  page.on('request', (sent) => {
    if (sent.method() !== 'GET' && sent.url().includes('/artifacts/')) {
      detaches.push(sent.method());
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

/** A scan the library holds as needs_ocr. Its text says SLOW, so the stub holds the read for a few seconds. */
async function uploadScan(page: Page, name: string): Promise<void> {
  await page
    .getByRole('main')
    .getByLabel('Upload artifacts')
    .setInputFiles({
      name,
      mimeType: 'image/png',
      buffer: Buffer.from(`SLOW ${name} invoice\n`),
    });
  await expect(page.getByRole('region', { name: 'Artifacts' }).getByText(name)).toBeVisible(COLD);
}

test('the library: OCR is asked for on a scan, its progress and estimate show while it runs, and the summary makes it searchable', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  test.slow();
  await digestsReady(request);

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
  // A read is kept, and it can be read again from the file as it is now.
  await expect(details.getByRole('button', { name: 'Read again with OCR' })).toBeVisible();
  // The read downloads as text: the OCR markdown, not the scan's bytes.
  const textHref =
    (await details.getByRole('link', { name: 'Download the text' }).getAttribute('href')) ?? '';
  const download = await page.request.get(textHref);
  expect(download.headers()['content-type']).toContain('text/plain');
  expect(await download.text()).toContain('Total due: 1,250.00');
  await expect(details.getByText(/Stub summary/)).toBeVisible(COLD);
  await shot(page, testInfo, 'ocr-02-done-with-summary');

  await page.getByLabel('Search artifacts').filter({ visible: true }).fill('invoice');
  await expect(list.locator('[data-artifact]', { hasText: 'scan-d.png' })).toBeVisible();
  // scan-e was never read, so nothing about it is in the index.
  await expect(list.locator('[data-artifact]', { hasText: 'scan-e.png' })).toHaveCount(0);
  await shot(page, testInfo, 'ocr-03-search-finds-the-scan');

  // Usage: four scans read (two pages each) and summarized from their text.
  await page.goto('/utilization');
  await expect(page.getByTestId('document-usage-pages').filter({ visible: true })).toHaveText('8', {
    timeout: 30_000,
  });
  // Five scans were each described from their pixels at upload, and four were then summarized from their text.
  await expect(page.getByText(/8 pages/).filter({ visible: true })).toBeVisible();
  await expect(
    page.getByText(/4 summaries · 5 pictures described/).filter({ visible: true })
  ).toBeVisible();

  // Phone width: the offer opens over the list, and the page does not scroll sideways.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto('/chat/artifacts');
  await page.getByLabel('Search artifacts').filter({ visible: true }).fill('');
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
  request,
  person: _person,
}, testInfo) => {
  test.slow();
  await digestsReady(request);

  await page.goto('/chat/artifacts');
  const list = page.getByRole('region', { name: 'Artifacts' });
  const details = page.getByRole('complementary', { name: 'Selected artifact' });
  await page
    .getByRole('main')
    .getByLabel('Upload artifacts')
    .setInputFiles({
      name: 'car-street.png',
      mimeType: 'image/png',
      buffer: Buffer.from('NOTEXT a red car on a street\n'),
    });
  await expect(list.getByText('car-street.png')).toBeVisible(COLD);
  await list.getByText('car-street.png').click();

  // Described from the picture itself: no text, and not waiting for OCR.
  // The digest is written in the background after the upload; the page
  // shows it once reloaded after that.
  await expect(async () => {
    await page.reload();
    await list.getByText('car-street.png').click();
    await expect(details.getByText(LLM_STUB_PICTURE)).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000, intervals: [500] });
  await expect(details.getByText('Waiting for OCR')).toHaveCount(0);
  await shot(page, testInfo, 'documents-01-photo-described');

  // OCR asked for: it reads nothing, which is a result, and the description stays.
  await details.getByRole('button', { name: 'Run OCR' }).click();
  await expect(details.getByText('No text', { exact: true })).toBeVisible(COLD);
  await expect(details.getByText(LLM_STUB_PICTURE)).toBeVisible();
  await shot(page, testInfo, 'documents-02-ocr-finds-no-text');

  // The uploader's usage: one picture described, and the pages OCR read.
  await page.goto('/utilization');
  const card = page.getByTestId('document-usage-card').filter({ visible: true });
  await expect(card).toBeVisible(COLD);
  await expect(page.getByTestId('document-usage-summaries').filter({ visible: true })).toHaveText(
    '1'
  );
  await expect(page.getByTestId('document-usage-pages').filter({ visible: true })).toHaveText('2');
  await expect(card.getByText(/12 tokens in/)).toBeVisible();
  // The Documents row in the breakdown says what the work was, not just its tokens.
  await expect(
    page.getByText(/1 OCR read, 2 pages · 1 picture described/).filter({ visible: true })
  ).toBeVisible();
  await shot(page, testInfo, 'documents-03-usage-documents-card');
});

declare global {
  interface Window {
    /** Files the iOS share stub was handed, by name (see the share test). */
    __shared: string[];
  }
}

test('the OCR text goes to the share sheet on the first tap in an iOS home-screen app', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  await digestsReady(request);
  // The iOS home-screen app's surface, stubbed: navigator.standalone is set,
  // and share records the file it was given instead of opening a sheet.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
    Object.defineProperty(window, '__shared', { value: [], configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', {
      value: async (data: { files: File[] }) => {
        window.__shared.push(...data.files.map((file) => file.name));
      },
      configurable: true,
    });
  });

  await page.goto('/chat/artifacts');
  const list = page.getByRole('region', { name: 'Artifacts' });
  const details = page.getByRole('complementary', { name: 'Selected artifact' });
  await uploadScan(page, 'scan-share.png');
  await list.getByText('scan-share.png').click();
  await details.getByRole('button', { name: 'Run OCR' }).click();
  const text = details.getByRole('link', { name: 'Download the text' });
  await expect(text).toBeVisible(COLD);
  // The first tap, straight after the link appears: the text was prefetched when it appeared.
  await text.click();
  await expect.poll(() => page.evaluate(() => window.__shared)).toEqual(['scan-share.txt']);
  await shot(page, testInfo, 'ocr-text-share-first-tap');
});
