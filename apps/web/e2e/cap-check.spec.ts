import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_TENANT_ID, AGENT_RICH_ID } from './seed';

// Proves the BUILDER validates against the org ceiling rather than the
// MAX_STEPS default: set the tenant ceiling to 1 and a multi-step agent must
// be refused naming 1, not 20.
test('builder honours the org step ceiling', async ({ page }) => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO tenant_settings (tenant_id, key, value) VALUES ($1, 'agent_max_steps', '1'::jsonb)
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [E2E_TENANT_ID]
    );

    await page.goto(`/${E2E_SLUG}/agents/${AGENT_RICH_ID}/edit`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText(/Keep the agent to 1 steps or fewer/)).toBeVisible();
  } finally {
    await client.query(
      `DELETE FROM tenant_settings WHERE tenant_id = $1 AND key = 'agent_max_steps'`,
      [E2E_TENANT_ID]
    );
    await client.end();
  }
});
