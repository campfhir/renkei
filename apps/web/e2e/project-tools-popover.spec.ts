/**
 * The Tools dialog in an open project chat must inherit the PROJECT's own
 * toolset before falling back to the person's personal default — the same
 * chat ?? project ?? userDefault ?? built-in chain the server already
 * enforces in tool-config.ts's `effectiveToolConfig` (and start-turn.ts's
 * `executeChatTurn`). Before this fix, the popover's own fallback chain
 * (`selected ?? personal ?? core`) skipped the project tier entirely, so a
 * brand-new chat in a project showed the person's personal default instead
 * — and toggling any box there would have written that wrong set onto the
 * chat's own tool_config, permanently overriding the project's setting.
 * See AGENTS.md's "UI changes" section — the convention this spec follows.
 *
 * The person is the test's own; their personal default and the project
 * are set through the routes the Tools popover and the new-project form
 * call (PUT /api/chat/tools, POST /api/chat/projects).
 */

import path from 'node:path';
import { test, expect } from './fixtures';

const SCREENS = path.join(import.meta.dirname, '..', 'test-results', 'screens');

test('a new chat in a project starts from the project’s toolset, not the person’s personal default', async ({
  page,
  person: _person,
}, testInfo) => {
  // This person's own personal chat default — deliberately just 'cards',
  // so it reads nothing like the project's own toolset (below) or the
  // built-in core set (agents, cards, knowledge, sandbox): a chat that
  // shows the wrong tier is unambiguous either way. ('knowledge' is left
  // out of both sets on purpose — its connector only registers once an
  // embedding provider is configured org-wide; 'agents'/'cards'/'sandbox'
  // need no such provisioning.)
  const personal = await page.request.put('/api/chat/tools', {
    data: { userDefault: { connectors: ['cards'] } },
  });
  expect(personal.ok(), await personal.text()).toBe(true);
  // The project's own toolset: agents only, no cards or sandbox —
  // distinct from both the personal default above and the core default.
  const created = await page.request.post('/api/chat/projects', {
    data: { name: 'Docs project', toolConfig: { connectors: ['agents'] } },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { projectId } = await created.json();

  // "+ New" inside the project: the real creation path (chat/new/page.tsx)
  // — an empty chat with tool_config = NULL, same as clicking the
  // project's own "+ New chat" button.
  await page.goto(`/chat/new?project=${projectId}`);
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);

  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Tools' });
  await expect(dialog.getByText('Starts from this project’s toolset')).toBeVisible();

  // The project's own toolset (agents only) is what shows checked — not
  // the person's personal default (cards only) and not the built-in core
  // set (agents, cards, knowledge, sandbox). Before this fix the popover
  // fell straight through to the personal default, so agents would show
  // unchecked and cards would show checked — the exact inversion asserted
  // here.
  await expect(page.getByRole('checkbox', { name: /Renkei agents/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Renkei cards/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Renkei sandbox/ })).not.toBeChecked();

  await page.screenshot({
    path: path.join(
      SCREENS,
      testInfo.project.name,
      'project-tools-popover-01-inherits-project.png'
    ),
    fullPage: false,
  });

  // Search narrows the list as you type; emptied, everything is back.
  const search = dialog.getByRole('searchbox', { name: 'Search connectors' });
  await search.fill('sand');
  await expect(dialog.getByRole('checkbox')).toHaveCount(1);
  await expect(dialog.getByRole('checkbox', { name: /Renkei sandbox/ })).toBeVisible();
  await page.screenshot({
    path: path.join(SCREENS, testInfo.project.name, 'project-tools-popover-03-search.png'),
    fullPage: false,
  });
  await search.fill('zzz');
  await expect(dialog.getByText('No connector matches “zzz”.')).toBeVisible();
  await search.fill('');
  await expect(dialog.getByRole('checkbox', { name: /Renkei agents/ })).toBeChecked();

  // The dialog keeps its actions in a footer under the list, which
  // scrolls in a box of its own when the catalog outgrows the screen.
  const footer = dialog.getByTestId('tools-dialog-footer');
  await expect(footer.getByRole('button', { name: 'Save as my default' })).toBeInViewport();
  await expect(footer.getByRole('button', { name: 'Done' })).toBeInViewport();
  await expect(dialog.getByTestId('tools-dialog-list')).toHaveCSS('overflow-y', 'auto');
  await footer.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);

  // Mobile-width check (a resized Chromium viewport, not the `mobile`
  // project's device descriptor — AGENTS.md's note): the dialog still
  // renders and reads correctly at phone width, its footer on screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Renkei agents/ })).toBeChecked();
  await expect(footer.getByRole('button', { name: 'Done' })).toBeInViewport();
  await page.screenshot({
    path: path.join(SCREENS, testInfo.project.name, 'project-tools-popover-02-mobile.png'),
    fullPage: false,
  });
});
