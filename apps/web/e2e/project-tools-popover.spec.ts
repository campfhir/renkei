/**
 * The Tools dialog in an open project chat, on the real server: a brand-new
 * chat in a project (tool_config NULL) shows the PROJECT's toolset checked,
 * because the chat page hands the dialog the project's toolset.
 *
 * The rules are tools-dialog.model.test.ts's: the chat ?? project ??
 * personal ?? built-in chain the server follows (tool-config.ts's
 * effectiveToolConfig), locked connectors, what a toggle pins and what
 * Save as my default sends, the search and its "No connector matches",
 * the explanation, and what the footer offers. What stays here is what
 * only a browser shows: the page wires the project's toolset into the
 * dialog (one open of it), the footer stays in the viewport while the
 * list scrolls in its own box, Done closes it, and it fits a phone.
 *
 * The person is the test's own; their personal default and the project
 * are set through the routes the Tools dialog and the new-project form
 * call (PUT /api/chat/tools, POST /api/chat/projects).
 */

import path from 'node:path';
import { test, expect } from './fixtures';
import { hydrated, redirectLanded } from './support/settle';

const SCREENS = path.join(import.meta.dirname, '..', 'test-results', 'screens');

test('a new chat in a project starts from the project’s toolset, not the person’s personal default', async ({
  page,
  person: _person,
}, testInfo) => {
  // A personal default (cards only) unlike both the project's toolset
  // (agents only) and the core set, so a chat showing the wrong tier is
  // unambiguous.
  const personal = await page.request.put('/api/chat/tools', {
    data: { userDefault: { connectors: ['cards'] } },
  });
  expect(personal.ok(), await personal.text()).toBe(true);
  const created = await page.request.post('/api/chat/projects', {
    data: { name: 'Docs project', toolConfig: { connectors: ['agents'] } },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { projectId } = await created.json();

  // "+ New" inside the project: the real creation path (chat/new/page.tsx).
  // A mid-stream redirect, finished by a second load a moment later: wait
  // for it to land and the thread to hydrate before the first press.
  await page.goto(`/chat/new?project=${projectId}`);
  await page.waitForURL(/\/chat\/[0-9a-f-]{36}$/);
  await redirectLanded(page);
  await hydrated(page, 'chat-thread');

  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Tools' });
  await expect(page.getByRole('checkbox', { name: /Renkei agents/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Renkei cards/ })).not.toBeChecked();

  await page.screenshot({
    path: path.join(
      SCREENS,
      testInfo.project.name,
      'project-tools-popover-01-inherits-project.png'
    ),
    fullPage: false,
  });

  // The actions stay in a footer under the list, which scrolls in a box
  // of its own when the catalog outgrows the screen.
  const footer = dialog.getByTestId('tools-dialog-footer');
  await expect(footer.getByRole('button', { name: 'Save as my default' })).toBeInViewport();
  await expect(footer.getByRole('button', { name: 'Done' })).toBeInViewport();
  await expect(dialog.getByTestId('tools-dialog-list')).toHaveCSS('overflow-y', 'auto');
  await footer.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);

  // Phone width (a resized viewport — AGENTS.md's note): the dialog still
  // renders, its footer on screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Renkei agents/ })).toBeChecked();
  await expect(footer.getByRole('button', { name: 'Done' })).toBeInViewport();
  await page.screenshot({
    path: path.join(SCREENS, testInfo.project.name, 'project-tools-popover-02-mobile.png'),
    fullPage: false,
  });
});
