import path from 'node:path';
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_TENANT_ID, AGENT_RICH_ID } from './seed';

// Knowledge notes are not seeded (they normally need an embedding provider),
// so this writes chunks directly — enough for the panel, which only reads
// rows. One note carries a long unbroken id, which is what used to overflow
// the card: min-w-0 cannot break a string with no break opportunity.
const LONG = 'ref-9f2c1a7e4b8d40f1a6c3e5079bd21c8a4f6e9012345678abcdef0123456789';

test('knowledge panel: selection, purge, and no overflow', async ({ page }, testInfo) => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const zero = `[${Array(1536).fill(0).join(',')}]`;
    for (const [i, body] of [
      `A short readable note.`,
      `Identifiers the model needs but nobody reads: ${LONG}`,
    ].entries()) {
      await client.query(
        `INSERT INTO knowledge_chunks (id, tenant_id, provider, ref_id, metadata, content, embedding, source_at)
         VALUES (gen_random_uuid(), $1, 'note', $2, $3::jsonb, $4, $5::vector, NOW())
         ON CONFLICT (tenant_id, provider, ref_id) DO NOTHING`,
        [
          E2E_TENANT_ID,
          `e2e@example.com/note-${i}`,
          JSON.stringify({
            kind: 'note',
            title: i === 0 ? 'Short note' : `Long identifiers ${LONG}`,
            authoredBy: i === 0 ? 'user' : 'agent',
            agentId: AGENT_RICH_ID,
            scope: 'agent',
          }),
          body,
          zero,
        ]
      );
    }

    await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}`);
    // CollapsibleSection is a native <details> on desktop, shut by default.
    await page.locator('summary', { hasText: 'Knowledge' }).click();
    await expect(page.getByText('Short note')).toBeVisible();

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
  } finally {
    await client.query(`DELETE FROM knowledge_chunks WHERE tenant_id = $1 AND provider = 'note'`, [
      E2E_TENANT_ID,
    ]);
    await client.end();
  }
});
