/**
 * The act-preview card (lib/mcp-widgets/src/act-preview.ts, act-render.ts):
 * the preview every act tool without a hand-written one draws in chat, one
 * layout per kind of act (act-card.ts).
 *
 * The real widget route, the real built bundle, the real chat thread: the
 * person asks in a chat on the stand-in model and the turn runs for real;
 * what the vendors' preview tools would have answered the model with —
 * they need the person's Jira, GitHub, Microsoft… grants, which only an
 * OAuth sign-in makes — is handed to the page as that turn's rows at the
 * stream's browser edge (e2e/support/tool-cards.ts). The confirm button's
 * `tools/call` is answered there too, since for real it would reach Jira;
 * the note and the model's reply after it are real.
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
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { LLM_STUB_REPLY } from './constants';
import { addStubModel, removeModel } from '../support/stub-model';
import { createChat, sendForCards, widgetUri } from '../support/tool-cards';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const COLD = { timeout: 30_000 };
const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');
const ACT_PREVIEW_URI = widgetUri('act-preview.ts', 'act-preview');

// Staging the stand-in model on the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

/** One preview: the tool the model called and the card it answered with. */
interface SeededCard {
  tool: string;
  input: Record<string, unknown>;
  card: Record<string, unknown>;
}

let nextPreview = 0;
function card(
  tool: string,
  input: Record<string, unknown>,
  shell: Record<string, unknown>
): SeededCard {
  nextPreview += 1;
  return {
    tool,
    input,
    card: {
      kind: 'act',
      previewId: `e2e-act-${nextPreview}-${randomUUID()}`,
      tone: 'neutral',
      confirmTool: `${tool.replace(/_preview$/, '')}_confirm`,
      confirmArgs: input,
      ...shell,
    },
  };
}

const COMMENT_INPUT = { issueKey: 'PROJ-12', comment: 'Looks good to me — shipping Friday.' };
const commentCard = () =>
  card('jira_add_comment_preview', COMMENT_INPUT, {
    verb: 'Comment',
    icon: 'comment',
    title: 'Comment on PROJ-12',
    subtitle: 'Jira',
    confirmLabel: 'Post comment',
    editable: [{ key: 'comment', label: 'Comment', multiline: true }],
    body: {
      kind: 'comment',
      mode: 'add',
      on: { label: 'PROJ-12' },
      bodyKey: 'comment',
      body: COMMENT_INPUT.comment,
    },
  });

/** One card per layout, for the gallery. */
function gallery(): SeededCard[] {
  return [
    commentCard(),
    card(
      'jsm_add_request_comment_preview',
      { issueKey: 'HELP-9', comment: 'We have reset your access.', isInternal: false },
      {
        verb: 'Reply',
        icon: 'comment',
        title: 'Reply to the customer on HELP-9',
        subtitle: 'Jira Service Management',
        editable: [{ key: 'comment', label: 'Reply', multiline: true }],
        body: {
          kind: 'comment',
          mode: 'add',
          on: { label: 'HELP-9', title: 'Request' },
          bodyKey: 'comment',
          body: 'We have reset your access.',
          badges: ['Public reply', 'The customer is notified'],
        },
      }
    ),
    card(
      'bitbucket_add_pr_comment_preview',
      {
        workspace: 'acme',
        repoSlug: 'app',
        id: 4,
        comment: 'Why not a Map here?',
        path: 'src/a.ts',
        line: 18,
      },
      {
        verb: 'Comment',
        icon: 'comment',
        title: 'Comment on src/a.ts in #4',
        subtitle: 'Bitbucket · acme/app',
        editable: [{ key: 'comment', label: 'Comment', multiline: true }],
        body: {
          kind: 'comment',
          mode: 'add',
          on: { label: '#4', title: 'Pull request', context: 'acme/app' },
          bodyKey: 'comment',
          body: 'Why not a Map here?',
          badges: ['Inline'],
          anchor: { file: 'src/a.ts', line: 18 },
        },
      }
    ),
    card(
      'jira_transition_issue_preview',
      { issueKey: 'PROJ-12', transitionName: 'Done' },
      {
        verb: 'Move',
        icon: 'arrow',
        title: 'Move PROJ-12 to Done',
        subtitle: 'Jira',
        body: {
          kind: 'transition',
          subject: { label: 'PROJ-12' },
          field: 'Workflow transition',
          to: 'Done',
        },
      }
    ),
    card(
      'jira_log_work_preview',
      { issueKey: 'PROJ-12', timeSpent: '1h 30m', comment: 'Pairing on the migration.' },
      {
        verb: 'Log time',
        icon: 'clock',
        title: 'Log 1h 30m on PROJ-12',
        subtitle: 'Jira',
        editable: [{ key: 'comment', label: 'What you worked on', multiline: true }],
        body: {
          kind: 'worklog',
          mode: 'log',
          on: { label: 'PROJ-12' },
          duration: '1h 30m',
          bodyKey: 'comment',
          body: 'Pairing on the migration.',
        },
      }
    ),
    card(
      'jira_create_issue_link_preview',
      { linkType: 'Blocks', fromIssueKey: 'PROJ-12', toIssueKey: 'PROJ-30' },
      {
        verb: 'Link',
        icon: 'link',
        title: 'Link PROJ-12 to PROJ-30',
        subtitle: 'Jira',
        body: {
          kind: 'link',
          mode: 'create',
          from: { label: 'PROJ-12' },
          relation: 'Blocks',
          to: { label: 'PROJ-30' },
        },
      }
    ),
    card(
      'github_grant_repository_permission_preview',
      { owner: 'acme', repo: 'app', username: 'sam', permission: 'push' },
      {
        verb: 'Grant',
        tone: 'caution',
        icon: 'users',
        title: 'Give sam push access to acme/app',
        subtitle: 'GitHub',
        body: {
          kind: 'access',
          mode: 'grant',
          who: [{ name: 'sam', kind: 'user' }],
          level: 'push',
          on: { label: 'acme/app', title: 'Repository' },
        },
      }
    ),
    card(
      'confluence_update_page_preview',
      { pageId: '98765', markdown: '# Handbook\n\nThe 2026 edition.', title: 'Handbook 2026' },
      {
        verb: 'Edit',
        icon: 'doc',
        title: 'Edit page 98765 — “Handbook 2026”',
        subtitle: 'Confluence',
        editable: [
          { key: 'title', label: 'Title', multiline: false },
          { key: 'markdown', label: 'New content', multiline: true },
        ],
        body: {
          kind: 'document',
          mode: 'update',
          type: 'Page',
          titleKey: 'title',
          title: 'Handbook 2026',
          location: ['Page 98765'],
          bodyKey: 'markdown',
          body: '# Handbook\n\nThe 2026 edition.',
          bodyLabel: 'The page will read',
          versionNote: 'Refresh for 2026',
        },
      }
    ),
    card(
      'onedrive_move_document_preview',
      { path: 'Reports/Q3.xlsx', destinationPath: 'Archive/2026' },
      {
        verb: 'Move',
        icon: 'folder',
        title: 'Move Q3.xlsx',
        subtitle: 'OneDrive',
        body: {
          kind: 'fileop',
          mode: 'move',
          items: [{ name: 'Q3.xlsx', path: '/Reports', type: 'file' }],
          to: { path: 'Archive/2026' },
          note: 'Links people already have keep working.',
        },
      }
    ),
    card(
      'github_commit_files_preview',
      { owner: 'acme', repo: 'app', branch: 'feature', message: 'Rename the helper', files: [] },
      {
        verb: 'Commit',
        icon: 'commit',
        title: 'Commit 3 files to feature',
        subtitle: 'GitHub · acme/app',
        editable: [{ key: 'message', label: 'Commit message', multiline: false }],
        body: {
          kind: 'commit',
          repo: 'acme/app',
          branch: 'feature',
          messageKey: 'message',
          message: 'Rename the helper',
          files: [
            { path: 'src/a.ts', status: 'modify', lines: 42 },
            { path: 'src/b.ts', status: 'add', lines: 9 },
            { path: 'src/old.ts', status: 'delete' },
          ],
        },
      }
    ),
    card(
      'bitbucket_approve_pull_request_preview',
      { workspace: 'acme', repoSlug: 'app', id: 4 },
      {
        verb: 'Approve',
        tone: 'positive',
        icon: 'check',
        title: 'Approve pull request #4',
        subtitle: 'Bitbucket · acme/app',
        body: {
          kind: 'verdict',
          verdict: 'approve',
          pullRequest: { label: '#4', title: 'Pull request', context: 'acme/app' },
        },
      }
    ),
    card(
      'outlook_create_event_preview',
      { subject: 'Standup', start: '2026-10-21T09:00:00', end: '2026-10-21T09:15:00' },
      {
        verb: 'Create',
        icon: 'calendar',
        title: 'Create the event “Standup”',
        subtitle: 'Outlook',
        body: {
          kind: 'event',
          mode: 'create',
          subject: 'Standup',
          start: '2026-10-21T09:00:00',
          end: '2026-10-21T09:15:00',
          timezone: 'America/Chicago',
          where: 'Room 4',
          online: true,
          recurrence: 'every week on Monday',
          attendees: [{ name: 'ana@example.com' }, { name: 'lee@example.com', optional: true }],
        },
      }
    ),
    card(
      'jira_complete_sprint_preview',
      { boardId: '3', sprintId: '41' },
      {
        verb: 'Complete',
        tone: 'caution',
        icon: 'sprint',
        title: 'Complete sprint 41',
        subtitle: 'Jira',
        body: {
          kind: 'sprint',
          mode: 'complete',
          sprint: {
            id: '41',
            name: 'Sprint 41',
            board: '3',
            start: '2026-10-05',
            end: '2026-10-19',
            goal: 'Ship the importer',
          },
        },
      }
    ),
    card(
      'bitbucket_update_pull_request_preview',
      { workspace: 'acme', repoSlug: 'app', id: 4, title: 'Faster importer' },
      {
        verb: 'Update',
        icon: 'merge',
        title: 'Update pull request #4',
        subtitle: 'Bitbucket · acme/app',
        body: {
          kind: 'change',
          subject: { label: '#4', title: 'Pull request', context: 'acme/app' },
          rows: [
            { label: 'Title', value: 'Faster importer' },
            { label: 'Reviewers', value: 'ana, lee' },
            { label: 'Labels', add: ['perf'], remove: ['wip'] },
          ],
          notes: ['Only what is shown changes.'],
        },
      }
    ),
    card(
      'outlook_move_message_preview',
      { messageId: 'AAMk', destinationFolder: 'archive' },
      {
        verb: 'Move',
        icon: 'folder',
        title: 'Move a message to archive',
        subtitle: 'Outlook',
        body: { kind: 'mailbox', mode: 'move', messages: '1 message', to: 'archive' },
      }
    ),
    card(
      'bitbucket_delete_branch_preview',
      { workspace: 'acme', repoSlug: 'app', name: 'old-feature' },
      {
        verb: 'Delete',
        tone: 'danger',
        icon: 'branch',
        title: 'Delete the branch old-feature',
        subtitle: 'Bitbucket · acme/app',
        body: { kind: 'branch', mode: 'delete', repo: 'acme/app', name: 'old-feature' },
      }
    ),
  ];
}

/** A chat of the person's own on the stand-in model, the cards shown as the reply. */
async function openCardChat(
  page: Page,
  testInfo: TestInfo,
  cards: SeededCard[]
): Promise<{ modelId: string; title: string }> {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag);
  const title = `Act preview (${tag})`;
  const chatId = await createChat(page.request, { modelId, title });
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible(COLD);
  await sendForCards(page, {
    chatId,
    modelId,
    prompt: 'Do these for me.',
    assistantText: 'Here are previews — nothing changes until you confirm.',
    cards: cards.map((seeded, index) => ({
      toolUseId: `toolu_act_${index}`,
      tool: seeded.tool,
      input: seeded.input,
      content: 'Awaiting the user’s decision on the preview card.',
      uiResourceUri: ACT_PREVIEW_URI,
      structuredContent: seeded.card,
    })),
  });
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

    ({ modelId } = await openCardChat(page, testInfo, [commentCard()]));

    const frame = page.frameLocator('iframe[title="Preview card"]');
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
    ({ modelId } = await openCardChat(page, testInfo, [commentCard()]));
    const frame = page.frameLocator('iframe[title="Preview card"]');
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
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  const cards = gallery();
  let modelId: string | null = null;
  try {
    ({ modelId } = await openCardChat(page, testInfo, cards));

    const frames = page.locator('iframe[title="Preview card"]');
    await expect(frames).toHaveCount(cards.length, COLD);
    for (const [index, seeded] of cards.entries()) {
      const frame = page.frameLocator('iframe[title="Preview card"]').nth(index);
      await expect(frame.locator('.card-title')).toHaveText(String(seeded.card.title), COLD);
      await expect(frame.locator('.a-verb')).toHaveText(String(seeded.card.verb));
      // Drawn by its own layout, not the "could not be prepared" fallback.
      await expect(frame.locator('.a-body')).toBeVisible();
      await expect(frame.locator('.status.error')).toHaveCount(0);
    }
    // Let every iframe grow to its content before the shots.
    await page.waitForTimeout(800);
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
    await page.waitForTimeout(800);
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
