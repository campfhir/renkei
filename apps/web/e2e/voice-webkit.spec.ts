/**
 * The read-aloud path in WebKit — the engine an iPhone runs, where the
 * composer was seen bobbing while a reply played. Chromium's fake
 * microphone cannot be fed a file here, so this is the part that needs no
 * microphone: press Listen, and prove the composer holds still while the
 * bars move. Same staging and the same measurement as voice.spec.ts
 * (e2e/support/voice.ts).
 *
 * It needs WebKit, which the browser suite's projects do not install: it
 * runs only where `PLAYWRIGHT_WEBKIT=1` says WebKit is there, and is
 * skipped otherwise.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { removeModel } from './support/stub-model';
import {
  CHAT_TITLE,
  expectComposerStillWhileReading,
  mockVendor,
  stageVoice,
  untilVoiceOffered,
  type VoiceChat,
} from './support/voice';

// The memory config's launch options name a Chromium binary; WebKit takes none.
test.use({
  roles: ['renkei-user', 'renkei-operator'],
  browserName: 'webkit',
  launchOptions: {},
});
test.skip(!process.env.PLAYWRIGHT_WEBKIT, 'WebKit is not installed for this suite.');

let voice: VoiceChat;

test.beforeEach(async ({ page, person: _person }, testInfo) => {
  // A built app may take a while to offer a speech service just switched on.
  test.slow();
  voice = await stageVoice(page.request, `${testInfo.project.name}-${randomUUID().slice(0, 6)}`);
  await untilVoiceOffered(page, voice.chatId);
});

test.afterEach(async ({ page }) => {
  await removeModel(page.request, voice.modelId);
});

test('webkit: the composer holds still while a reply is read aloud', async ({ page }) => {
  await mockVendor(page);
  await page.goto(`/chat/${voice.chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: CHAT_TITLE })).toBeVisible();
  await expectComposerStillWhileReading(page);
});
