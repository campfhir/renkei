/**
 * The voice surfaces, end to end in a browser and without a speech vendor:
 * the admin setup form, the preferences section, the speaker menu, a reply
 * read aloud, and the immersive voice conversation through its states —
 * listening, the person's utterance transcribed, thinking, speaking.
 *
 * The org's configuration is seeded into connector_configs the way the
 * admin form stores it, so the server-side availability check is real.
 * Everything that would reach the vendor is answered at the browser edge
 * (`page.route`): the voice catalog, synthesis (a silent WAV the browser
 * really plays), transcription, and the turn the utterance becomes (a
 * canned SSE reply), so the thread and the voice mode behave exactly as
 * they would with a model and a vendor behind them.
 *
 * The microphone is Chromium's fake capture device fed a WAV of silence,
 * then a tone, then silence — one utterance, which the recorder's speech
 * detection cuts out and sends.
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
  expectComposerStillWhileReading,
  mockVendor,
  seedVoice,
  shot,
  wav,
} from './voice-fixtures';

const FAKE_MIC = path.join(RESULTS, 'voice-fake-mic.wav');

/** Silence, a 1.5 s tone, silence: what the fake microphone "hears". */
function fakeMicrophone(): Buffer {
  const rate = 48_000;
  const seconds = 40;
  const samples = new Float32Array(rate * seconds);
  for (let index = rate * 3; index < rate * 4.5; index += 1) {
    samples[index] = 0.3 * Math.sin((2 * Math.PI * 440 * index) / rate);
  }
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

test('setup: the Voice connector in the admin catalog and its form', async ({ page }, testInfo) => {
  await mockVendor(page);
  await page.goto(`/${E2E_SLUG}/admin/connectors`);
  await expect(page.getByRole('heading', { name: 'Connector setup' })).toBeVisible();
  await page.getByLabel('Find a connector').fill('voice');
  await expect(page.getByRole('link', { name: 'Open Voice' })).toBeVisible();
  await shot(page, testInfo, 'voice-01-admin-catalog');

  await page.goto(`/${E2E_SLUG}/admin/connectors/voice`);
  await expect(page.getByRole('heading', { level: 1, name: 'Voice' })).toBeVisible();
  await expect(page.getByLabel('Region')).toHaveValue('eastus');
  await expect(page.getByLabel('API key')).toHaveAttribute('placeholder', /Stored/);
  await shot(page, testInfo, 'voice-02-admin-setup');

  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('Connected: 612 voices in 153 languages.')).toBeVisible();
  await shot(page, testInfo, 'voice-03-admin-setup-tested');
});

test('setup: the Voice section under Preferences', async ({ page }, testInfo) => {
  await mockVendor(page);
  await page.goto(`/${E2E_SLUG}/preferences`);
  const section = page.getByRole('region', { name: 'Voice' });
  await expect(section).toBeVisible();
  await expect(section.getByRole('combobox', { name: 'Voice' })).toContainText('Sonia');
  await expect(
    section.getByRole('button', { name: /Hear a sample in British English/ })
  ).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'voice-04-preferences', false);
});

test('chat: the speaker menu, a reply read aloud, and a voice conversation', async ({
  page,
}, testInfo) => {
  await mockVendor(page);
  await page.goto(`/${E2E_SLUG}/chat/${CHAT_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: CHAT_TITLE })).toBeVisible();

  // The speaker menu: read-aloud, language, voice, speed, and the way in.
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('combobox').filter({ hasText: 'Sonia' })).toBeVisible();
  await shot(page, testInfo, 'voice-05-speaker-menu', false);
  await page.keyboard.press('Escape');

  // Listen under the reply: the assistant speaks, the composer's speaker
  // becomes a wave, the button becomes Stop.
  const reply = page.getByText('Two issues slipped out of the sprint:');
  await reply.hover();
  await expectComposerStillWhileReading(page);
  await expect(page.getByRole('button', { name: 'Voice', exact: true })).toHaveAttribute(
    'title',
    'Reading the reply aloud'
  );
  await shot(page, testInfo, 'voice-06-reply-read-aloud', false);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();

  // Dictation: the microphone beside the box; the fake microphone speaks
  // at three seconds and the words land in the box, to edit and send.
  await page.getByRole('button', { name: 'Dictate' }).click();
  await expect(page.getByRole('button', { name: 'Stop dictating' })).toBeVisible();
  await expect(page.getByLabel('Message')).toHaveAttribute('placeholder', /Speak, then pause/);
  await shot(page, testInfo, 'voice-06b-dictating', false);
  await expect(page.getByLabel('Message')).toHaveValue(UTTERANCE, { timeout: 30_000 });
  await shot(page, testInfo, 'voice-06c-dictated', false);
  await page.getByRole('button', { name: 'Stop dictating' }).click();
  await page.getByLabel('Message').fill('');

  // The voice conversation, through its states.
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await page.getByRole('menuitem', { name: /Start a voice conversation/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Voice conversation' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Listening', { exact: true })).toBeVisible({ timeout: 15_000 });
  await shot(page, testInfo, 'voice-07-mode-listening', false);

  // The fake microphone speaks at three seconds; the utterance is cut,
  // transcribed and sent, and the reply takes a moment to arrive. The
  // recognition is asked for once: at the utterance's first pause, ahead
  // of the recorder closing it (lib/voice/recorder.ts's onSpeechPause),
  // and the close takes that answer rather than asking again.
  let recognitions = 0;
  page.on('request', (request) => {
    if (/\/voice\/transcribe/.test(request.url())) recognitions += 1;
  });
  await expect(dialog.getByText(UTTERANCE)).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText('Thinking…')).toBeVisible({ timeout: 10_000 });
  await shot(page, testInfo, 'voice-08-mode-heard-thinking', false);
  expect(recognitions).toBe(1);

  await expect(dialog.getByText('Speaking — talk to interrupt')).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText(/Two issues slipped out of the last sprint/)).toBeVisible();
  await shot(page, testInfo, 'voice-09-mode-speaking', false);

  // Leaving voice mode leaves the conversation in the chat, in writing.
  await dialog.getByRole('button', { name: 'Type instead' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(UTTERANCE)).toBeVisible();
  await expect(page.getByText(/Two issues slipped out of the last sprint/)).toBeVisible();
  await shot(page, testInfo, 'voice-10-after-conversation', false);
});

test('chat: a voice conversation says what it is doing, and asks before it acts', async ({
  page,
}, testInfo) => {
  await mockVendor(page, { asks: true });
  await page.goto(`/${E2E_SLUG}/chat/${CHAT_ID}`);
  await expect(page.getByRole('heading', { level: 1, name: CHAT_TITLE })).toBeVisible();
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await page.getByRole('menuitem', { name: /Start a voice conversation/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Voice conversation' });
  await expect(dialog.getByText('Listening', { exact: true })).toBeVisible({ timeout: 15_000 });

  // The utterance is sent; the first thing the turn does is search, and
  // the line under the wave says so while it runs.
  await expect(dialog.getByText(UTTERANCE)).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText('Searching Jira issues…')).toBeVisible({ timeout: 15_000 });
  await shot(page, testInfo, 'voice-11-mode-working', false);

  // Then it wants to act, and the ask is shown and spoken: the label
  // tells the person what to say, the panel has the three buttons.
  await expect(
    dialog.getByText('Permission needed — say allow, always allow, or deny')
  ).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText('The assistant wants to create Jira issue.')).toBeVisible();
  await shot(page, testInfo, 'voice-12-mode-permission', false);

  // Allowed from the panel: the turn carries on and the reply is read.
  await dialog.getByRole('button', { name: 'Allow once' }).click();
  await expect(dialog.getByText('Speaking — talk to interrupt')).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, 'voice-13-mode-after-allow', false);
});
