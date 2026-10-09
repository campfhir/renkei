/**
 * Files a tool produced, shown in the reply that produced them as small
 * pictures of themselves — the first page, the first slide, the corner of
 * the first sheet — each with its Download right under it; end to end in a
 * browser, from seeded rows alone (no model is called):
 *
 *   - a PDF's first page painted by pdf.js; a Word file's first page laid
 *     out by docx-preview and a deck's first slide by pptx-preview, both in
 *     sandboxed frames; a workbook's first sheet as a spreadsheet grid
 *     (column letters, row numbers, bold, numbers set right, a formula
 *     never computed shown as itself); Markdown on a
 *     page; a legacy deck as the text extracted at upload;
 *   - pages keep a page's shape and slides a slide's, with no border;
 *   - a file with no faithful picture (a zip) is its name and Download only;
 *   - each Download sits under its own file, not in the reply's Copy row;
 *   - at a phone's width every picture stays inside the screen.
 *
 * The documents are real files, made by @renkei/document-render the way the
 * file tools make them. Their bytes are not in a blob store here, so the
 * browser's requests for them are answered by `page.route`; so is the
 * workbook's /preview (its JSON comes from the parser the route uses). The
 * legacy deck's preview is the real route, reading the sealed text.
 * Own tenant per project (the way llm-models.spec.ts does it).
 *
 * Runs on the pinned Chromium only; "mobile" is a resized viewport (see
 * AGENTS.md's "UI changes" section).
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import ExcelJS from 'exceljs';
import { Client } from 'pg';
import { keyFor } from './keys';
import { renderDocument } from '@renkei/document-render';
import { sheetFromXlsx } from '../lib/chat/sheet-preview';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** The first hit on a route compiles it (`next dev` builds lazily). */
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
  const id = (what: string) => uuidFrom(`artifact-inline-e2e:${what}:${projectName}`);
  return {
    id,
    sessionId: id('session'),
    slug: `e2e-artifact-inline-${projectName}`,
    subject: `e2e-artifacts-${projectName}@example.com`,
    chatModelId: id('chat-model'),
    chatId: id('chat'),
    turnId: id('turn'),
    call: `toolu_files_${projectName}`,
  };
}
type Fixture = ReturnType<typeof fixtureFor>;

function secretbox(plaintext: string, encoded: string): string {
  const key = Buffer.from(encoded, 'base64');
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
const sealSecret = (plaintext: string) =>
  secretbox(plaintext, process.env.TOKEN_ENCRYPTION_KEY ?? '');

const PDF_MD = '# Quarterly report\n\nRevenue grew in every region.\n\n## Detail\n\nEMEA led.';
const DOCX_MD = '# Board memo\n\nThe frog has the nuggets.\n\n- First point\n- Second point';
const NOTES_MD = '# Release notes\n\n- Inline previews\n- Download beside Copy';
const DECK_MD =
  '# Roadmap for Q4\n\n- Ship the previews\n- Keep the frog fed\n\n# Second slide\n\nNot drawn.';
const LEGACY_TEXT = 'Old deck\n\nNotes from the 2019 offsite';

interface Seeded {
  id: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  extractStatus: string;
  extractedText?: string;
}

async function filesFor(f: Fixture): Promise<Seeded[]> {
  const pdf = await renderDocument('pdf', 'report.pdf', PDF_MD);
  const docx = await renderDocument('docx', 'memo.docx', DOCX_MD);
  const deck = await renderDocument('pptx', 'deck.pptx', DECK_MD);
  const workbook = new ExcelJS.Workbook();
  const sales = workbook.addWorksheet('Sales');
  sales.getColumn(1).width = 18;
  sales.addRow(['Region', 'Units']).font = { bold: true };
  sales.addRow(['EMEA', 1200]);
  sales.addRow(['APAC', 900]);
  // A formula as the renderer writes one: no cached result until Excel opens it.
  sales.addRow(['Total', { formula: 'SUM(B2:B3)' }]);
  workbook.addWorksheet('Notes').addRow(['Checked by finance']);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  return [
    {
      id: f.id('pdf'),
      filename: 'report.pdf',
      contentType: 'application/pdf',
      bytes: pdf.bytes,
      extractStatus: 'done',
    },
    {
      id: f.id('docx'),
      filename: 'memo.docx',
      contentType: docx.mediaType,
      bytes: docx.bytes,
      extractStatus: 'done',
    },
    {
      id: f.id('xlsx'),
      filename: 'q4.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: xlsx,
      extractStatus: 'done',
    },
    {
      id: f.id('md'),
      filename: 'notes.md',
      contentType: 'text/markdown',
      bytes: Buffer.from(NOTES_MD),
      extractStatus: 'done',
    },
    {
      id: f.id('pptx'),
      filename: 'deck.pptx',
      contentType: deck.mediaType,
      bytes: deck.bytes,
      extractStatus: 'done',
    },
    {
      id: f.id('ppt'),
      filename: 'old.ppt',
      contentType: 'application/vnd.ms-powerpoint',
      bytes: Buffer.from('not served'),
      extractStatus: 'done',
      extractedText: LEGACY_TEXT,
    },
    {
      id: f.id('zip'),
      filename: 'bundle.zip',
      contentType: 'application/zip',
      bytes: Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'latin1'),
      extractStatus: 'unsupported',
    },
  ];
}

async function seed(f: Fixture, files: Seeded[]): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    for (const table of [
      'chat_attachments',
      'chats',
      'llm_model_configs',
      'user_preferences',
      'sessions',
      'identities',
    ]) {
      await client.query(`DELETE FROM ${table}`, [f.tenantId]);
    }
    await client.query('DELETE FROM tenants WHERE id = $1', [f.tenantId]);
    await client.query('INSERT INTO tenants (id, slug) VALUES ($1, $2)', [f.tenantId, f.slug]);
    await client.query(
      `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [f.sessionId, f.tenantId, f.subject, ['renkei-user'], new Date(Date.now() + 24 * 3_600_000)]
    );
    await client.query(
      `INSERT INTO identities (tenant_id, subject, email, display_name) VALUES ($1, $2, $3, 'E2E Tester')`,
      [f.tenantId, f.subject, f.subject]
    );
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [f.tenantId, f.subject]
    );
    await client.query(
      `INSERT INTO llm_model_configs (id, tenant_id, label, provider, model, base_url, encrypted_secrets, enabled, is_default)
       VALUES ($1, $2, 'Chatty', 'anthropic', 'e2e-model', 'http://127.0.0.1:8092/anthropic', $3, true, false)`,
      [f.chatModelId, f.tenantId, sealSecret(JSON.stringify({ apiKey: 'e2e' }))]
    );
    await client.query(
      `INSERT INTO chats (id, tenant_id, owner_subject, title, llm_model_id, last_message_at)
       VALUES ($1, $2, $3, 'Quarter files', $4, NOW())`,
      [f.chatId, f.tenantId, f.subject, f.chatModelId]
    );
    const chatKey = await keyFor(client, {
      kind: 'chat',
      resourceId: f.chatId,
      ownerSubject: f.subject,
    });
    await client.query(
      `INSERT INTO chat_turns (id, tenant_id, chat_id, status, llm_model_id, iterations, finished_at)
       VALUES ($1, $2, $3, 'completed', $4, 2, NOW())`,
      [f.turnId, f.tenantId, f.chatId, f.chatModelId]
    );
    const rows: { seq: number; role: string; kind: string; blocks: unknown[] }[] = [
      {
        seq: 1,
        role: 'user',
        kind: 'prompt',
        blocks: [{ type: 'text', text: 'make me the quarter files' }],
      },
      {
        seq: 2,
        role: 'assistant',
        kind: 'assistant',
        blocks: [
          { type: 'text', text: 'Writing them now.' },
          {
            type: 'tool_use',
            id: f.call,
            name: 'chat_write_file',
            input: { filename: 'report.pdf' },
          },
        ],
      },
      {
        seq: 3,
        role: 'user',
        kind: 'tool_results',
        blocks: [
          {
            type: 'tool_result',
            toolUseId: f.call,
            content: 'Wrote seven files. They are under this chat’s Artifacts.',
            durationMs: 2_000,
          },
        ],
      },
      {
        seq: 4,
        role: 'assistant',
        kind: 'assistant',
        blocks: [{ type: 'text', text: 'Here are the quarter files.' }],
      },
    ];
    let resultsRow = '';
    for (const row of rows) {
      const assistant = row.role === 'assistant';
      const inserted = await client.query(
        `INSERT INTO chat_messages (tenant_id, chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model, stop_reason)
         VALUES ($1, $2, $3, $4, $5, $6, 'complete', $7, $8, $9, $10, $11) RETURNING id`,
        [
          f.tenantId,
          f.chatId,
          f.turnId,
          row.seq,
          row.role,
          row.kind,
          chatKey.seal(JSON.stringify(row.blocks)),
          assistant ? f.chatModelId : null,
          assistant ? 'anthropic' : null,
          assistant ? 'e2e-model' : null,
          assistant ? (row.seq === 4 ? 'end_turn' : 'tool_use') : null,
        ]
      );
      if (row.kind === 'tool_results') resultsRow = inserted.rows[0].id;
    }
    for (const file of files) {
      await client.query(
        `INSERT INTO chat_attachments (id, tenant_id, owner_subject, chat_id, blob_key, filename, content_type, size_bytes, extract_status, extracted_text, origin, message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'model', $11)`,
        [
          file.id,
          f.tenantId,
          f.subject,
          f.chatId,
          `chat/${f.tenantId}/${file.id}`,
          file.filename,
          file.contentType,
          file.bytes.byteLength,
          file.extractStatus,
          file.extractedText ? chatKey.seal(file.extractedText) : null,
          resultsRow,
        ]
      );
    }
  } finally {
    await client.end();
  }
}

async function serveFiles(page: Page, f: Fixture, files: Seeded[]): Promise<void> {
  for (const file of files) {
    await page.route(`**/api/chat/attachments/${file.id}`, (route) =>
      route.fulfill({
        status: 200,
        // As the real route does: only an image, a PDF or plain text is named as itself.
        contentType: /^(application\/pdf|text\/plain)$/.test(file.contentType)
          ? file.contentType
          : 'application/octet-stream',
        body: file.bytes,
        headers: {
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
        },
      })
    );
  }
  const workbook = files.find((file) => file.filename === 'q4.xlsx')!;
  const sheet = await sheetFromXlsx(new Uint8Array(workbook.bytes));
  await page.route(`**/api/chat/attachments/${workbook.id}/preview`, (route) =>
    route.fulfill({ status: 200, json: { kind: 'sheet', sheet } })
  );
}

async function signIn(page: Page, f: Fixture): Promise<void> {
  await page.context().addCookies([
    {
      name: `renkei_session`,
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
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      name
    ),
    fullPage: true,
  });
}

let fixture: Fixture;
let files: Seeded[];

// eslint-disable-next-line no-empty-pattern -- Playwright reads fixtures off the first parameter's destructuring; this one needs none
test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Chromium-only spec; see AGENTS.md.');
  fixture = fixtureFor(testInfo.project.name);
  files = await filesFor(fixture);
  await seed(fixture, files);
});

/** The rendered picture's height over its width. */
async function shapeOf(card: ReturnType<Page['getByTestId']>): Promise<number> {
  const box = await card.locator('> div').first().boundingBox();
  expect(box).not.toBeNull();
  return box!.height / box!.width;
}

test('the files a reply produced are shown as pictures of their first page, each with its Download', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await serveFiles(page, fixture, files);
  await signIn(page, fixture);
  await page.goto(`/chat/${fixture.chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Quarter files' })).toBeVisible(COLD);

  // One card per file, in the order the tool kept them; the zip is a name only.
  const cards = page.getByTestId('artifact-inline');
  await expect(cards).toHaveCount(7, COLD);
  const kinds = ['pdf', 'docx', 'sheet', 'text', 'pptx', 'extract', 'none'];
  for (const [index, kind] of kinds.entries()) {
    await expect(cards.nth(index)).toHaveAttribute('data-kind', kind);
  }
  const [pdf, docx, sheet, notes, deck, legacy, zip] = kinds.map((_, index) => cards.nth(index));

  // The PDF: its first page painted, not blank.
  await pdf.scrollIntoViewIfNeeded();
  const pageOne = pdf.getByRole('img', { name: 'Page 1' });
  await expect(pageOne).toBeVisible(COLD);
  await expect
    .poll(
      () =>
        pageOne.evaluate((canvas: HTMLCanvasElement) => {
          const context = canvas.getContext('2d');
          if (!context) return 0;
          const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
          let dark = 0;
          for (let index = 0; index < data.length; index += 4) {
            if (data[index] < 128 && data[index + 3] > 0) dark++;
          }
          return dark;
        }),
      COLD
    )
    .toBeGreaterThan(100);

  // The Word file's first page and the deck's first slide, each in a frame nothing can run in.
  for (const testId of ['artifact-inline-docx', 'artifact-inline-pptx']) {
    await expect(page.getByTestId(testId)).toHaveAttribute('sandbox', 'allow-same-origin');
  }
  await docx.scrollIntoViewIfNeeded();
  await expect(
    page.frameLocator('[data-testid="artifact-inline-docx"]').getByText('The frog has the nuggets.')
  ).toBeVisible(COLD);
  const slide = page.frameLocator('[data-testid="artifact-inline-pptx"]');
  await expect(slide.getByText('Roadmap for Q4')).toBeVisible(COLD);
  await expect(slide.getByText('Not drawn.')).toHaveCount(0);

  // The workbook: the first sheet's corner as a spreadsheet, the rest counted.
  await sheet.scrollIntoViewIfNeeded();
  await expect(sheet.getByRole('columnheader', { name: 'A', exact: true })).toBeVisible(COLD);
  await expect(sheet.getByRole('rowheader', { name: '1', exact: true })).toBeVisible();
  await expect(sheet.getByRole('cell', { name: 'Region' })).toHaveCSS('font-weight', '700');
  await expect(sheet.getByRole('cell', { name: '1200' })).toHaveCSS('text-align', 'right');
  await expect(sheet.getByRole('cell', { name: '=SUM(B2:B3)' })).toBeVisible();
  await expect(sheet).toContainText('+1 more');
  await expect(sheet.getByText('Checked by finance')).toHaveCount(0);

  // Markdown on a page; the legacy deck as its extracted text.
  await notes.scrollIntoViewIfNeeded();
  await expect(notes.getByRole('heading', { name: 'Release notes' })).toBeVisible(COLD);
  await expect(legacy).toContainText('Notes from the 2019 offsite', COLD);

  // Shapes: a PDF keeps its own page's (A4, as the file tools make it), the
  // other pages are Letter-shaped, a slide is 16:9, and nothing is boxed in.
  expect(await shapeOf(pdf)).toBeCloseTo(Math.SQRT2, 2);
  for (const card of [docx, notes, legacy]) {
    expect(await shapeOf(card)).toBeCloseTo(11 / 8.5, 2);
  }
  expect(await shapeOf(deck)).toBeCloseTo(9 / 16, 2);
  for (const card of [pdf, docx, sheet, notes, deck, legacy]) {
    await expect(card.locator('> div').first()).toHaveCSS('border-top-width', '0px');
  }

  // Each Download is right under its own file — the zip's too — not in the Copy row.
  for (const card of [pdf, docx, sheet, notes, deck, legacy]) {
    const picture = await card.locator('> div').first().boundingBox();
    const link = await card.getByTestId('artifact-download').boundingBox();
    expect(link!.y).toBeGreaterThan(picture!.y + picture!.height - 1);
  }
  await expect(zip.getByText('bundle.zip')).toBeVisible();
  await expect(zip.getByTestId('artifact-download')).toBeVisible();
  const copy = page.getByRole('button', { name: 'Copy', exact: true });
  await expect(copy).toBeVisible();
  await expect(copy.locator('xpath=..').getByTestId('artifact-download')).toHaveCount(0);
  const saved = page.waitForEvent('download');
  await docx.getByRole('link', { name: 'Download memo.docx' }).click();
  expect((await saved).suggestedFilename()).toBe('memo.docx');
  await shot(page, testInfo, 'artifact-inline.png');
  // Each card on its own: the thread scrolls inside the page, so a page shot shows only the last.
  for (const [index, card] of [pdf, docx, sheet, notes, deck, legacy, zip].entries()) {
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({
      path: path.join(
        import.meta.dirname,
        '..',
        'test-results',
        'screens',
        testInfo.project.name,
        `artifact-card-${index}-${kinds[index]}.png`
      ),
    });
  }

  // Phone width: every picture inside the screen, no sideways scroll.
  await page.setViewportSize(MOBILE_VIEWPORT);
  for (let index = 0; index < 7; index++) {
    const box = await cards.nth(index).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await shot(page, testInfo, 'artifact-inline-mobile.png');
});
