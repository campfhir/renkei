/**
 * Talking while the assistant is busy, in the immersive voice
 * conversation: what is said while a reply is still being worked out
 * cancels nothing — it queues as the next message, voice mode says so,
 * and it goes out once the reply has been read. The fake microphone
 * speaks twice: once to ask, and once more while the model is "thinking"
 * (the reply held back long enough for that second utterance to land).
 * The rules themselves — a few words over a reply being READ interrupt
 * it, a short sound never does — are pinned without a microphone in
 * lib/voice/barge-in.test.ts and lib/voice/recorder.test.ts.
 *
 * Its own spec file because the fake microphone is a launch option, one
 * file per spec: voice.spec.ts's single utterance stays as it is.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG } from './seed';
import {
  CHAT_ID,
  CHAT_TITLE,
  RESULTS,
  UTTERANCE,
  mockVendor,
  seedVoice,
  shot,
  wav,
} from './voice-fixtures';

const FAKE_MIC = path.join(RESULTS, 'voice-barge-in-fake-mic.wav');

/**
 * Silence, a 1.5 s tone (the question), silence, then a 2 s tone at
 * eight seconds — well over the few words' worth of voice that counts
 * as talking — while the reply is still being worked out; then silence.
 */
function fakeMicrophone(): Buffer {
  const rate = 48_000;
  const seconds = 40;
  const samples = new Float32Array(rate * seconds);
  const tone = (from: number, to: number) => {
    for (let index = rate * from; index < rate * to; index += 1) {
      samples[index] = 0.3 * Math.sin((2 * Math.PI * 440 * index) / rate);
    }
  };
  tone(3, 4.5);
  tone(8, 10);
  return wav(samples, rate);
}

mkdirSync(RESULTS, { recursive: true });
writeFileSync(FAKE_MIC, fakeMicrophone());

test.use({
  permissions: ['microphone'],
  // The mobile project's device descriptor asks for WebKit, which is not
  // installed here; the pinned Chromium runs every project.
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${FAKE_MIC}%noloop`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

test.beforeAll(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await seedVoice(client);
  } finally {
    await client.end();
  }
});

test('talking while the reply is worked out queues the next message instead of stopping it', async ({
  page,
}, testInfo) => {
  // The reply takes a while: the second utterance lands while "Thinking…".
  await mockVendor(page, { replyDelayMs: 14_000 });
  let cancels = 0;
  page.on('request', (request) => {
    if (/\/turns\/[^/]+\/cancel$/.test(request.url())) cancels += 1;
  });
  await page.goto(`/${E2E_SLUG}/chat/${CHAT_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: CHAT_TITLE })).toBeVisible();
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await page.getByRole('menuitem', { name: /Start a voice conversation/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Voice conversation' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Listening', { exact: true })).toBeVisible({ timeout: 15_000 });

  // The question is heard, sent, and the model takes its time.
  await expect(dialog.getByText(UTTERANCE)).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText('Thinking…')).toBeVisible({ timeout: 10_000 });

  // The second utterance, over the thinking: nothing is stopped — the
  // turn is not cancelled and the label stays — and the words wait.
  const queued = dialog.locator('[data-voice-queued]');
  await expect(queued).toBeVisible({ timeout: 20_000 });
  await expect(queued).toHaveText(/Your next message is queued/);
  await expect(dialog.getByText('Thinking…')).toBeVisible();
  expect(cancels).toBe(0);
  await shot(page, testInfo, 'voice-14-queued-while-thinking', false);

  // The reply arrives and is read; the queued message still waits, since
  // sending it would silence the reading mid-sentence.
  await expect(dialog.getByText('Speaking — talk to interrupt')).toBeVisible({ timeout: 30_000 });
  await expect(queued).toBeVisible();
  await shot(page, testInfo, 'voice-15-queued-while-speaking', false);

  // Once the reply has been read, the queued message goes out on its own:
  // a new turn, and nothing left waiting.
  await expect(dialog.getByText('Thinking…')).toBeVisible({ timeout: 30_000 });
  await expect(queued).toHaveCount(0);
  expect(cancels).toBe(0);

  // Phone width: the same lines, nothing spilling.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'voice-16-thinking-mobile', false);
});
