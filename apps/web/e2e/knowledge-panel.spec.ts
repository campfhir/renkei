/**
 * An agent's Knowledge panel in a browser: real notes render, one press
 * reaches the panel's model, and nothing overflows. What the panel does
 * with selection, drafts and deletes is knowledge-panel.model.test.ts's
 * (app/(app)/agents/[agentId]/). The notes are added the way the panel's own form adds them
 * (POST /api/agents/:id/knowledge), embedded synchronously by the
 * organization's embedding provider — the stand-in model's /embeddings
 * (e2e/llm-stub.mjs), configured through the admin route and left on.
 * One note carries a long unbroken id, which is what used to overflow the
 * card: min-w-0 cannot break a string with no break opportunity.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './fixtures';
import { LLM_STUB_BASE_URL } from './constants';

const LONG = 'ref-9f2c1a7e4b8d40f1a6c3e5079bd21c8a4f6e9012345678abcdef0123456789';

// Configuring the embedding provider is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

test('knowledge panel: selection, purge, and no overflow', async ({
  page,
  person: _person,
}, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const embeddings = await page.request.put('/api/admin/connectors/embeddings', {
    data: { baseUrl: LLM_STUB_BASE_URL, model: 'stub-embedding', apiKey: 'stub-key' },
  });
  expect(embeddings.ok(), await embeddings.text()).toBe(true);

  const created = await page.request.post('/api/agents', {
    data: { name: `Knowledge keeper ${tag}`, instructions: 'Keep notes.', tools: [], triggers: [] },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { agentId } = await created.json();
  for (const [title, content] of [
    ['Short note', 'A short readable note.'],
    [`Long identifiers ${LONG}`, `Identifiers the model needs but nobody reads: ${LONG}`],
  ]) {
    const note = await page.request.post(`/api/agents/${agentId}/knowledge`, {
      data: { title, content },
    });
    expect(note.status(), await note.text()).toBe(201);
  }

  await page.goto(`/agents/${agentId}`);
  // CollapsibleSection is a native <details> on desktop, shut by default.
  // A click before hydration can be undone by it: open it until it stays open.
  await expect(async () => {
    const section = page.locator('details', {
      has: page.locator('summary', { hasText: 'Knowledge' }),
    });
    if ((await section.getAttribute('open')) === null) {
      await section.locator('summary').click();
    }
    await expect(page.getByText('Short note')).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  // The selection toolbar and the purge affordance both exist.
  await expect(page.getByText('Select all')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear knowledge' })).toBeVisible();

  await page.getByRole('checkbox', { name: 'Select Short note' }).check();
  await expect(page.getByRole('button', { name: 'Delete 1' })).toBeVisible();

  // Nothing may spill horizontally out of the page.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
  );
  expect(overflow).toBe(true);

  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      'knowledge-panel.png'
    ),
    fullPage: true,
  });
});
