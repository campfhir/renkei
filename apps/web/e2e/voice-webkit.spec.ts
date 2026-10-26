/**
 * The read-aloud path in WebKit — the engine an iPhone runs, where the
 * composer was seen bobbing while a reply played. Chromium's fake
 * microphone cannot be fed a file here, so this is the part that needs no
 * microphone: press Listen, and prove the composer holds still while the
 * bars move. Same fixtures and the same measurement as voice.spec.ts.
 */

import { test, expect } from './worker-env';
import { Client } from 'pg';
import {
  CHAT_ID,
  CHAT_TITLE,
  expectComposerStillWhileReading,
  mockVendor,
  seedVoice,
} from './voice-fixtures';
import { isolateFile } from './worker-env';

// Each file starts from a database of its own: this runs before the file's other hooks.
test.beforeAll(isolateFile);

test.use({ browserName: 'webkit' });

test.beforeAll(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await seedVoice(client);
  } finally {
    await client.end();
  }
});

test('webkit: the composer holds still while a reply is read aloud', async ({ page }) => {
  await mockVendor(page);
  await page.goto(`/chat/${CHAT_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: CHAT_TITLE })).toBeVisible();
  await expectComposerStillWhileReading(page);
});
