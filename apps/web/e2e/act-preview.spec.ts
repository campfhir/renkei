/**
 * The act-preview card (lib/mcp-widgets/src/act-preview.ts, act-render.ts):
 * the preview every act tool without a hand-written one draws in chat, one
 * layout per kind of act (act-card.ts).
 *
 * All of it real: the person connects each vendor through its Connect
 * link (the in-memory app's fake OAuth), a chat turn on the stand-in model
 * calls the previews — which write nothing and reach no vendor, so every
 * card is the app's own builder's — and the real widget route serves the
 * built bundle. Only the confirm button's `tools/call` is answered at the
 * browser edge, since for real it would reach Jira; the note and the
 * model's reply after it are real.
 *
 * Proves:
 *  - a comment card shows the comment where it will land, lets the person
 *    rewrite the words, and the confirm button sends THEIR words to the
 *    tool's `_confirm` twin with the rest of the arguments unchanged;
 *  - Cancel runs nothing;
 *  - every kind of card draws (a gallery of one card per layout, screenshot
 *    for review) and none overflows a phone-width viewport.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { LLM_STUB_REPLY } from './constants';
import { addStubModel, removeModel, scripted } from './support/stub-model';
import { createChat } from './support/tool-cards';
import { previewChat } from './support/preview-cards';
import {
  addConnectors,
  connectJira,
  connectThrough,
  registerConnector,
} from './support/connectors';
import { connectCodeHost, prepareCodeHost } from './support/code-host';
import { send } from './support/chat';
import { steady } from './support/settle';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const COLD = { timeout: 30_000 };
const RESULTS = path.join(import.meta.dirname, '..', 'test-results');

// Staging the stand-in model on the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const COMMENT_INPUT = { issueKey: 'PROJ-12', comment: 'Looks good to me — shipping Friday.' };

/** One preview the model calls, and how its card is headed. */
interface GalleryCard {
  tool: string;
  input: Record<string, unknown>;
  verb: string;
  title: string;
}

/** One card per layout, for the gallery. */
const GALLERY: GalleryCard[] = [
  {
    tool: 'jira_add_comment_preview',
    input: COMMENT_INPUT,
    verb: 'Comment',
    title: 'Comment on PROJ-12',
  },
  {
    tool: 'jsm_add_request_comment_preview',
    input: { issueKey: 'HELP-9', comment: 'We have reset your access.', isInternal: false },
    verb: 'Reply',
    title: 'Reply to the customer on HELP-9',
  },
  {
    tool: 'bitbucket_add_pr_comment_preview',
    input: {
      workspace: 'acme',
      repoSlug: 'app',
      id: 4,
      comment: 'Why not a Map here?',
      path: 'src/a.ts',
      line: 18,
    },
    verb: 'Comment',
    title: 'Comment on src/a.ts in #4',
  },
  {
    tool: 'jira_transition_issue_preview',
    input: { issueKey: 'PROJ-12', transitionName: 'Done' },
    verb: 'Move',
    title: 'Move PROJ-12 to Done',
  },
  {
    tool: 'jira_log_work_preview',
    input: { issueKey: 'PROJ-12', timeSpent: '1h 30m', comment: 'Pairing on the migration.' },
    verb: 'Log time',
    title: 'Log 1h 30m on PROJ-12',
  },
  {
    tool: 'jira_create_issue_link_preview',
    input: { linkType: 'Blocks', fromIssueKey: 'PROJ-12', toIssueKey: 'PROJ-30' },
    verb: 'Link',
    title: 'Link PROJ-12 to PROJ-30',
  },
  {
    tool: 'github_grant_repository_permission_preview',
    input: { owner: 'acme', repo: 'app', username: 'sam', permission: 'push' },
    verb: 'Grant',
    title: 'Give sam push access to acme/app',
  },
  {
    tool: 'confluence_update_page_preview',
    input: { pageId: '98765', markdown: '# Handbook\n\nThe 2026 edition.', title: 'Handbook 2026' },
    verb: 'Edit',
    title: 'Edit page 98765 — “Handbook 2026”',
  },
  {
    tool: 'onedrive_move_document_preview',
    input: { path: 'Reports/Q3.xlsx', destinationPath: 'Archive/2026' },
    verb: 'Move',
    title: 'Move Q3.xlsx',
  },
  {
    tool: 'github_commit_files_preview',
    input: {
      owner: 'acme',
      repo: 'app',
      branch: 'feature',
      message: 'Rename the helper',
      files: [
        { path: 'src/a.ts', content: 'export const a = 1;\n' },
        { path: 'src/b.ts', content: 'export const b = 2;\n' },
      ],
      delete: ['src/old.ts'],
    },
    verb: 'Commit',
    title: 'Commit 3 files to feature',
  },
  {
    tool: 'bitbucket_approve_pull_request_preview',
    input: { workspace: 'acme', repoSlug: 'app', id: 4 },
    verb: 'Approve',
    title: 'Approve pull request #4',
  },
  {
    tool: 'outlook_create_event_preview',
    input: { subject: 'Standup', start: '2026-10-21T09:00:00', end: '2026-10-21T09:15:00' },
    verb: 'Create',
    title: 'Create the event “Standup”',
  },
  {
    tool: 'jira_complete_sprint_preview',
    input: { boardId: '3', sprintId: '41' },
    verb: 'Complete',
    title: 'Complete sprint 41',
  },
  {
    tool: 'bitbucket_update_pull_request_preview',
    input: { workspace: 'acme', repoSlug: 'app', id: 4, title: 'Faster importer' },
    verb: 'Update',
    title: 'Update pull request #4',
  },
  {
    tool: 'outlook_move_message_preview',
    input: { messageId: 'AAMk', destinationFolder: 'archive' },
    verb: 'Move',
    title: 'Move a message to archive',
  },
  {
    tool: 'bitbucket_delete_branch_preview',
    input: { workspace: 'acme', repoSlug: 'app', name: 'old-feature' },
    verb: 'Delete',
    title: 'Delete the branch old-feature',
  },
];

/**
 * The comment card as a person meets it: Jira connected (the in-memory
 * app's fake OAuth), and a real turn whose model calls
 * jira_add_comment_preview — a preview writes nothing and reaches no
 * vendor, so its card is the app's own builder's.
 */
async function openCommentChat(
  page: Page,
  testInfo: TestInfo
): Promise<{ modelId: string; title: string }> {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  await connectJira(page);
  const modelId = await addStubModel(page.request, tag);
  const title = `Act preview (${tag})`;
  await previewChat(page, {
    modelId,
    title,
    prompt: 'Tell PROJ-12 it looks good.',
    steps: [
      {
        text: 'Here is a preview — nothing changes until you confirm.',
        tools: [{ name: 'jira_add_comment_preview', input: COMMENT_INPUT }],
      },
      { text: 'Waiting on your decision.' },
    ],
  }).then(({ chatId }) => page.goto(`/chat/${chatId}`));
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible(COLD);
  return { modelId, title };
}

/**
 * Every vendor the gallery's cards act on, connected for the person the
 * way their Connect links do it (the in-memory app's fake OAuth), and one
 * real turn whose model calls each preview: their cards are the builders'.
 */
async function openGalleryChat(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  cards: GalleryCard[]
): Promise<{ modelId: string; title: string }> {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  await connectJira(page);
  await prepareCodeHost(request);
  await connectCodeHost(page, 'bitbucket');
  await connectCodeHost(page, 'github');
  await registerConnector(
    page.request,
    'microsoft',
    {
      clientId: 'e2e-microsoft-client',
      clientSecret: 'e2e-microsoft-secret',
      directoryTenantId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    },
    ['directoryTenantId']
  );
  await addConnectors(page.request, ['microsoft']);
  await connectThrough(page, '/api/microsoft/authorize');
  for (const atlassian of ['atlassian-confluence', 'atlassian-jsm']) {
    await registerConnector(page.request, atlassian, {
      clientId: `e2e-${atlassian}-client`,
      clientSecret: `e2e-${atlassian}-secret`,
    });
    await connectThrough(page, `/api/${atlassian}/authorize`);
  }
  const modelId = await addStubModel(page.request, tag);
  const title = `Act preview (${tag})`;
  const chatId = await createChat(page.request, { modelId, title });
  const configured = await page.request.patch(`/api/chat/chats/${chatId}`, {
    data: {
      toolConfig: {
        connectors: [
          'atlassian-bitbucket',
          'atlassian-confluence',
          'github',
          'jira',
          'microsoft',
          'onedrive',
        ],
      },
    },
  });
  expect(configured.ok(), await configured.text()).toBe(true);
  const view = await send(
    page.request,
    chatId,
    scripted('Do these for me.', [
      {
        text: 'Here are previews — nothing changes until you confirm.',
        tools: cards.map((seeded) => ({ name: seeded.tool, input: seeded.input })),
      },
      { text: 'Waiting on your decisions.' },
    ]),
    modelId,
    { allow: true, timeout: 120_000 }
  );
  // Every preview answered with its card, none refused.
  const refused = view.messages
    .flatMap((message) => message.blocks)
    .filter((block) => JSON.stringify(block).includes('"isError":true'));
  expect(refused, JSON.stringify(refused)).toEqual([]);
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible(COLD);
  return { modelId, title };
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, name),
    fullPage: true,
  });
}

function noteLine(page: Page, text: string) {
  return page.locator('p[title]', { hasText: text });
}

/**
 * The host iframe (widget-card.tsx) sizes itself from `size-changed`
 * messages the card posts after it renders, with its own 120ms CSS
 * transition on top — a check inside the iframe's own document (anything
 * through `frameLocator`) can be satisfied well before that outer element
 * has grown or shrunk to match, which raced a full-page screenshot ahead
 * of the host's resize and clipped a still-growing card. Poll the host
 * element itself so a shot only happens once it has actually caught up.
 */
function cardHeight(page: Page): Promise<number> {
  return page
    .locator('iframe[title="Preview card"]')
    .boundingBox()
    .then((box) => box?.height ?? 0);
}
async function waitForCardHeightAtLeast(page: Page, minHeight: number): Promise<void> {
  await expect.poll(() => cardHeight(page), COLD).toBeGreaterThanOrEqual(minHeight);
}
async function waitForCardHeightBelow(page: Page, maxHeight: number): Promise<void> {
  await expect.poll(() => cardHeight(page), COLD).toBeLessThan(maxHeight);
}

test('a comment card shows the comment, takes the person’s rewrite, and confirms THEIR words', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  let modelId: string | null = null;
  try {
    const confirmCall: { value: { name: unknown; arguments: unknown } | null } = { value: null };
    await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
      confirmCall.value = route.request().postDataJSON();
      await route.fulfill({
        json: {
          result: {
            content: [{ type: 'text', text: 'Commented on PROJ-12.' }],
            isError: false,
            meta: {},
          },
        },
      });
    });

    ({ modelId } = await openCommentChat(page, testInfo));

    const frame = page.getByRole('main').frameLocator('iframe[title="Preview card"]');
    await expect(frame.locator('.card-title')).toHaveText('Comment on PROJ-12', COLD);
    await expect(frame.locator('.a-verb')).toHaveText('Comment');
    await expect(frame.locator('.a-ref-label')).toHaveText('PROJ-12');
    // It is a comment bubble on the issue, not a list of arguments.
    await expect(frame.getByText('You will post')).toBeVisible();
    const box = frame.getByLabel('Comment');
    await expect(box).toHaveValue(COMMENT_INPUT.comment);
    await waitForCardHeightAtLeast(page, 220);
    await shot(page, testInfo, 'act-preview-comment.png');

    await box.fill('Approved — please ship it today.');
    await frame.getByRole('button', { name: 'Post comment' }).click();
    await expect(frame.locator('.done-headline')).toHaveText('Commented on PROJ-12.');
    await waitForCardHeightBelow(page, 150);
    await shot(page, testInfo, 'act-preview-comment-done.png');

    // The twin, with the person's words over the model's, nothing else changed.
    expect(confirmCall.value?.name).toBe('jira_add_comment_confirm');
    expect(confirmCall.value?.arguments).toEqual({
      issueKey: 'PROJ-12',
      comment: 'Approved — please ship it today.',
    });

    await expect(
      noteLine(page, 'The user confirmed "Comment on PROJ-12" on the preview card')
    ).toBeVisible(COLD);
    // The decision opened a turn of its own, and the model answered it.
    await expect(page.getByText(LLM_STUB_REPLY).first()).toBeVisible(COLD);
  } finally {
    if (modelId) await removeModel(page.request, modelId);
  }
});

test('cancelling a card runs nothing', async ({ page, person: _person }, testInfo) => {
  test.setTimeout(150_000);
  let modelId: string | null = null;
  try {
    let confirmed = false;
    await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
      confirmed = true;
      await route.abort();
    });
    ({ modelId } = await openCommentChat(page, testInfo));
    const frame = page.getByRole('main').frameLocator('iframe[title="Preview card"]');
    await expect(frame.locator('.card-title')).toHaveText('Comment on PROJ-12', COLD);
    await frame.getByRole('button', { name: 'Cancel' }).click();
    await expect(frame.locator('.done-headline')).toHaveText('Cancelled');
    await expect(
      noteLine(page, 'The user cancelled "Comment on PROJ-12" from the preview card')
    ).toBeVisible(COLD);
    expect(confirmed).toBe(false);
  } finally {
    if (modelId) await removeModel(page.request, modelId);
  }
});

test('every kind of card draws, and none overflows a phone', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  const cards = GALLERY;
  let modelId: string | null = null;
  try {
    ({ modelId } = await openGalleryChat(page, request, testInfo, cards));

    const frames = page.locator('iframe[title="Preview card"]');
    await expect(frames).toHaveCount(cards.length, COLD);
    for (const [index, seeded] of cards.entries()) {
      const frame = page.frameLocator('iframe[title="Preview card"]').nth(index);
      await expect(frame.locator('.card-title')).toHaveText(seeded.title, COLD);
      await expect(frame.locator('.a-verb')).toHaveText(seeded.verb);
      // Drawn by its own layout, not the "could not be prepared" fallback.
      await expect(frame.locator('.a-body')).toBeVisible();
      await expect(frame.locator('.status.error')).toHaveCount(0);
    }
    // Let every iframe grow to its content before the shots.
    const heights = () =>
      frames.evaluateAll((all) => all.map((frame) => frame.getBoundingClientRect().height));
    await steady(page, heights);
    for (const [index, seeded] of cards.entries()) {
      await frames.nth(index).scrollIntoViewIfNeeded();
      await frames.nth(index).screenshot({
        path: path.join(
          RESULTS,
          'screens',
          testInfo.project.name,
          `act-preview-${String(index + 1).padStart(2, '0')}-${seeded.tool.replace(/_preview$/, '')}.png`
        ),
      });
    }

    await page.setViewportSize(MOBILE_VIEWPORT);
    await steady(page, heights);
    const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    for (let index = 0; index < cards.length; index += 1) {
      const frame = page.frameLocator('iframe[title="Preview card"]').nth(index);
      const overflow = await frame
        .locator('body')
        .evaluate((body) => body.scrollWidth - body.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
    await shot(page, testInfo, 'act-preview-gallery-mobile.png');
  } finally {
    if (modelId) await removeModel(page.request, modelId);
  }
});
