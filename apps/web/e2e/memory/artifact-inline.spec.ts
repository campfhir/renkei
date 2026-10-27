/**
 * Files a tool produced, shown in the reply that produced them as small
 * pictures of themselves — the first page, the first slide, the corner of
 * the first sheet — each with its Download right under it; end to end in a
 * browser:
 *
 *   - a PDF's first page painted by pdf.js; a Word file's first page laid
 *     out by docx-preview and a deck's first slide by pptx-preview, both in
 *     sandboxed frames; a workbook's first sheet as a spreadsheet grid
 *     (column letters, row numbers, numbers set right, a formula never
 *     computed shown as itself); Markdown on a page;
 *   - pages keep a page's shape and slides a slide's, with no border;
 *   - each Download sits under its own file, not in the reply's Copy row;
 *   - at a phone's width every picture stays inside the screen.
 *
 * The documents are real: the scripted stand-in model
 * (e2e/support/stub-model.ts) asks chat_write_file for each, the app's own
 * tool renders them (@renkei/document-render) into the blob store, and the
 * page reads them back through the real routes, the workbook's /preview
 * included. (A legacy deck shown as the text extracted at upload, and a
 * zip shown as its name only, are files the write tool cannot make; their
 * cards are not reachable from a reply here.)
 *
 * Runs on one project; "mobile" is a resized viewport (see AGENTS.md's
 * "UI changes" section).
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from '../support/stub-model';
import { createChat, send } from '../support/chat';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** The first hit on a route compiles it (`next dev` builds lazily). */
const COLD = { timeout: 30_000 };

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const PROMPT = 'make me the quarter files';
const PDF_MD = '# Quarterly report\n\nRevenue grew in every region.\n\n## Detail\n\nEMEA led.';
const DOCX_MD = '# Board memo\n\nThe frog has the nuggets.\n\n- First point\n- Second point';
const NOTES_MD = '# Release notes\n\n- Inline previews\n- Download beside Copy';
const DECK_MD =
  '# Roadmap for Q4\n\n- Ship the previews\n- Keep the frog fed\n\n# Second slide\n\nNot drawn.';
const WORKBOOK = JSON.stringify({
  sheets: [
    {
      name: 'Sales',
      rows: [
        ['Region', 'Units'],
        ['EMEA', 1200],
        ['APAC', 900],
        // A formula as the renderer writes one: no cached result until Excel opens it.
        ['Total', '=SUM(B2:B3)'],
      ],
    },
    { name: 'Notes', rows: [['Checked by finance']] },
  ],
});

const write = (filename: string, content: string) => ({
  name: 'chat_write_file',
  input: { filename, content },
});

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      name
    ),
    fullPage: true,
  });
}

/** The rendered picture's height over its width. */
async function shapeOf(card: ReturnType<Page['getByTestId']>): Promise<number> {
  const box = await card.locator('> div').first().boundingBox();
  if (!box) throw new Error('The card has no picture on screen.');
  return box.height / box.width;
}

test('the files a reply produced are shown as pictures of their first page, each with its Download', async ({
  page,
  person: _person,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'One project is enough for the pictures.');
  test.setTimeout(180_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag, {
    script: [
      {
        when: PROMPT,
        steps: [
          {
            text: 'Writing them now.',
            tools: [
              write('report.pdf', PDF_MD),
              write('memo.docx', DOCX_MD),
              write('q4.xlsx', WORKBOOK),
              write('notes.md', NOTES_MD),
              write('deck.pptx', DECK_MD),
            ],
          },
          { text: 'Here are the quarter files.' },
        ],
      },
    ],
  });
  try {
    const chatId = await createChat(page.request, { llmModelId: modelId, title: 'Quarter files' });
    // Writing files acts, so each call asks first: allowed once, as the card would.
    await send(page.request, chatId, PROMPT, modelId, { allow: true, timeout: 120_000 });

    await page.goto(`/chat/${chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Quarter files' })).toBeVisible(COLD);

    // One card per file, in the order the tool kept them.
    const cards = page.getByTestId('artifact-inline');
    await expect(cards).toHaveCount(5, COLD);
    const kinds = ['pdf', 'docx', 'sheet', 'text', 'pptx'];
    for (const [index, kind] of kinds.entries()) {
      await expect(cards.nth(index)).toHaveAttribute('data-kind', kind);
    }
    const [pdf, docx, sheet, notes, deck] = kinds.map((_, index) => cards.nth(index));

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
      page
        .frameLocator('[data-testid="artifact-inline-docx"]')
        .getByText('The frog has the nuggets.')
    ).toBeVisible(COLD);
    const slide = page.frameLocator('[data-testid="artifact-inline-pptx"]');
    await expect(slide.getByText('Roadmap for Q4')).toBeVisible(COLD);
    await expect(slide.getByText('Not drawn.')).toHaveCount(0);

    // The workbook: the first sheet's corner as a spreadsheet, the rest counted.
    await sheet.scrollIntoViewIfNeeded();
    await expect(sheet.getByRole('columnheader', { name: 'A', exact: true })).toBeVisible(COLD);
    await expect(sheet.getByRole('rowheader', { name: '1', exact: true })).toBeVisible();
    await expect(sheet.getByRole('cell', { name: 'Region' })).toBeVisible();
    await expect(sheet.getByRole('cell', { name: '1200' })).toHaveCSS('text-align', 'right');
    await expect(sheet.getByRole('cell', { name: '=SUM(B2:B3)' })).toBeVisible();
    await expect(sheet).toContainText('+1 more');
    await expect(sheet.getByText('Checked by finance')).toHaveCount(0);

    // Markdown on a page.
    await notes.scrollIntoViewIfNeeded();
    await expect(notes.getByRole('heading', { name: 'Release notes' })).toBeVisible(COLD);

    // Shapes: a PDF keeps its own page's (A4, as the file tools make it), the
    // other pages are Letter-shaped, a slide is 16:9, and nothing is boxed in.
    expect(await shapeOf(pdf)).toBeCloseTo(Math.SQRT2, 2);
    for (const card of [docx, notes]) {
      expect(await shapeOf(card)).toBeCloseTo(11 / 8.5, 2);
    }
    expect(await shapeOf(deck)).toBeCloseTo(9 / 16, 2);
    for (const card of [pdf, docx, sheet, notes, deck]) {
      await expect(card.locator('> div').first()).toHaveCSS('border-top-width', '0px');
    }

    // Each Download is right under its own file, not in the Copy row.
    for (const card of [pdf, docx, sheet, notes, deck]) {
      const picture = await card.locator('> div').first().boundingBox();
      const link = await card.getByTestId('artifact-download').boundingBox();
      if (!picture || !link) throw new Error('A card is missing its picture or its Download.');
      expect(link.y).toBeGreaterThan(picture.y + picture.height - 1);
    }
    const copy = page.getByRole('button', { name: 'Copy', exact: true }).last();
    await expect(copy).toBeVisible();
    await expect(copy.locator('xpath=..').getByTestId('artifact-download')).toHaveCount(0);
    const saved = page.waitForEvent('download');
    await docx.getByRole('link', { name: 'Download memo.docx' }).click();
    expect((await saved).suggestedFilename()).toBe('memo.docx');
    await shot(page, testInfo, 'artifact-inline.png');

    // Each card on its own: the thread scrolls inside the page, so a page shot shows only the last.
    for (const [index, card] of [pdf, docx, sheet, notes, deck].entries()) {
      await card.scrollIntoViewIfNeeded();
      await card.screenshot({
        path: path.join(
          import.meta.dirname,
          '..',
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
    for (let index = 0; index < 5; index++) {
      const box = await cards.nth(index).boundingBox();
      if (!box) throw new Error('A card is not on screen.');
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await shot(page, testInfo, 'artifact-inline-mobile.png');
  } finally {
    await removeModel(page.request, modelId);
  }
});
