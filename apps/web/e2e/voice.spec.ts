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

import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const FAKE_MIC = path.join(RESULTS, 'voice-fake-mic.wav');

/** A 16-bit mono PCM WAV of the samples. */
function wav(samples: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    data.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

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

/**
 * What "synthesis" returns: four seconds the browser really plays — a
 * low tone swelling and fading like speech, so the wave and its glow have
 * an output level to follow in the shots.
 */
function spokenPiece(): Buffer {
  const rate = 16_000;
  const samples = new Float32Array(rate * 4);
  for (let index = 0; index < samples.length; index += 1) {
    const t = index / rate;
    const syllables = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3.1 * t);
    samples[index] = 0.35 * syllables * Math.sin(2 * Math.PI * 180 * t);
  }
  return wav(samples, rate);
}
const SPOKEN_PIECE = spokenPiece();

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

const CHAT_ID = '78787878-7878-4787-8787-787878787871';
const TURN_ID = '78787878-7878-4787-8787-787878787872';
const MODEL_ID = '78787878-7878-4787-8787-787878787873';
const NEW_TURN_ID = '78787878-7878-4787-8787-787878787874';
const NEW_USER_MESSAGE_ID = '78787878-7878-4787-8787-787878787875';
const NEW_ASSISTANT_MESSAGE_ID = '78787878-7878-4787-8787-787878787876';
const CHAT_TITLE = 'Sprint retro prep';
const UTTERANCE = 'Which issues slipped out of the last sprint, and who owns them?';
const SPOKEN_REPLY =
  'Two issues slipped out of the last sprint. OPS-41, rotating the Zoom webhook secret, is still ' +
  'in progress with Priya. OPS-44, backfilling the file share index, has not been started and is ' +
  'assigned to Marcus. Both are still open; shall I move them into the next sprint for you?';

const REPLY_MARKDOWN = [
  'Two issues slipped out of the sprint:',
  '',
  '| Key | Summary | Status |',
  '| --- | --- | --- |',
  '| OPS-41 | Rotate the Zoom webhook secret | In Progress |',
  '| OPS-44 | Backfill the fileshare index | To Do |',
  '',
  'Both are still assigned. Want me to **move them** into the next sprint?',
].join('\n');

function secretbox(plaintext: string): string {
  const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64');
  if (key.byteLength !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

function seal(plaintext: string): string {
  const encoded = process.env.CONTENT_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEY || '';
  const key = Buffer.from(encoded, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return (
    'renc1:' +
    [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      ciphertext.toString('base64'),
    ].join('.')
  );
}

async function seedVoice(client: Client): Promise<void> {
  // The org's speech service, as the admin form stores it.
  await client.query('DELETE FROM connector_configs WHERE tenant_id = $1 AND connector = $2', [
    E2E_TENANT_ID,
    'voice',
  ]);
  await client.query(
    `INSERT INTO connector_configs (tenant_id, connector, enabled, settings, encrypted_secrets)
     VALUES ($1, 'voice', true, $2, $3)`,
    [
      E2E_TENANT_ID,
      JSON.stringify({
        provider: 'azure-speech',
        region: 'eastus',
        endpoint: '',
        defaultVoice: 'en-US-AvaMultilingualNeural',
        defaultLocale: 'en-US',
      }),
      secretbox(JSON.stringify({ apiKey: 'e2e-speech-key' })),
    ]
  );
  // This person's own voice: a British voice, a touch faster than natural.
  await client.query(
    'DELETE FROM user_preferences WHERE tenant_id = $1 AND subject = $2 AND key = $3',
    [E2E_TENANT_ID, E2E_SUBJECT, 'voice']
  );
  await client.query(
    `INSERT INTO user_preferences (tenant_id, subject, key, value, updated_at)
     VALUES ($1, $2, 'voice', $3, NOW())`,
    [
      E2E_TENANT_ID,
      E2E_SUBJECT,
      JSON.stringify({
        voice: 'en-GB-SoniaNeural',
        rate: 1.25,
        autoPlay: false,
        locale: 'en-GB',
        accent: 'rainbow',
        userAccent: 'emerald',
      }),
    ]
  );

  // A chat with one completed turn, so there is a reply to Listen to.
  await client.query('DELETE FROM chats WHERE id = $1', [CHAT_ID]);
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [MODEL_ID]);
  await client.query(
    `INSERT INTO llm_model_configs (id, tenant_id, label, provider, model, encrypted_secrets, enabled, is_default)
     VALUES ($1, $2, 'Claude Sonnet 5', 'anthropic', 'claude-sonnet-5', $3, true, false)`,
    [MODEL_ID, E2E_TENANT_ID, secretbox(JSON.stringify({ apiKey: 'e2e' }))]
  );
  await client.query(
    `INSERT INTO chats (id, tenant_id, owner_subject, title, llm_model_id, thinking_enabled, last_message_at)
     VALUES ($1, $2, $3, $4, $5, false, NOW())`,
    [CHAT_ID, E2E_TENANT_ID, E2E_SUBJECT, CHAT_TITLE, MODEL_ID]
  );
  await client.query(
    `INSERT INTO chat_turns (id, tenant_id, chat_id, status, llm_model_id, iterations, input_tokens, output_tokens, finished_at)
     VALUES ($1, $2, $3, 'completed', $4, 1, 800, 210, NOW())`,
    [TURN_ID, E2E_TENANT_ID, CHAT_ID, MODEL_ID]
  );
  const rows = [
    {
      seq: 1,
      role: 'user',
      kind: 'prompt',
      blocks: [{ type: 'text', text: 'What slipped out of the OPS sprint?' }],
    },
    {
      seq: 2,
      role: 'assistant',
      kind: 'assistant',
      blocks: [{ type: 'text', text: REPLY_MARKDOWN }],
    },
  ];
  for (const row of rows) {
    const assistant = row.role === 'assistant';
    await client.query(
      `INSERT INTO chat_messages (tenant_id, chat_id, turn_id, seq, role, kind, status, content, llm_model_id, provider, model, stop_reason)
       VALUES ($1, $2, $3, $4, $5, $6, 'complete', $7, $8, $9, $10, $11)`,
      [
        E2E_TENANT_ID,
        CHAT_ID,
        TURN_ID,
        row.seq,
        row.role,
        row.kind,
        seal(JSON.stringify(row.blocks)),
        assistant ? MODEL_ID : null,
        assistant ? 'anthropic' : null,
        assistant ? 'claude-sonnet-5' : null,
        assistant ? 'end_turn' : null,
      ]
    );
  }
}

const VOICES = [
  {
    id: 'en-US-AvaMultilingualNeural',
    name: 'Ava Multilingual',
    locale: 'en-US',
    gender: 'female',
  },
  {
    id: 'en-US-AndrewMultilingualNeural',
    name: 'Andrew Multilingual',
    locale: 'en-US',
    gender: 'male',
  },
  { id: 'en-US-EmmaNeural', name: 'Emma', locale: 'en-US', gender: 'female' },
  { id: 'en-GB-SoniaNeural', name: 'Sonia', locale: 'en-GB', gender: 'female' },
  { id: 'en-GB-RyanNeural', name: 'Ryan', locale: 'en-GB', gender: 'male' },
  { id: 'en-AU-NatashaNeural', name: 'Natasha', locale: 'en-AU', gender: 'female' },
  { id: 'de-DE-KatjaNeural', name: 'Katja', locale: 'de-DE', gender: 'female' },
  { id: 'fr-FR-DeniseNeural', name: 'Denise', locale: 'fr-FR', gender: 'female' },
  { id: 'es-ES-ElviraNeural', name: 'Elvira', locale: 'es-ES', gender: 'female' },
  { id: 'ja-JP-NanamiNeural', name: 'Nanami (七海)', locale: 'ja-JP', gender: 'female' },
];

/** One SSE frame as the stream route writes them. */
function frame(seq: number, event: Record<string, unknown>): string {
  return `event: turn\nid: ${seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The canned reply the utterance's turn streams back. */
function replyStream(): string {
  const createdAt = new Date().toISOString();
  const events: Record<string, unknown>[] = [
    {
      type: 'message_start',
      messageId: NEW_ASSISTANT_MESSAGE_ID,
      turnId: NEW_TURN_ID,
      seq: 101,
      role: 'assistant',
      kind: 'assistant',
      llmModelId: MODEL_ID,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      createdAt,
    },
    {
      type: 'block_start',
      messageId: NEW_ASSISTANT_MESSAGE_ID,
      index: 0,
      block: { type: 'text', text: '' },
    },
    { type: 'text_delta', messageId: NEW_ASSISTANT_MESSAGE_ID, index: 0, text: SPOKEN_REPLY },
    {
      type: 'block_stop',
      messageId: NEW_ASSISTANT_MESSAGE_ID,
      index: 0,
      block: { type: 'text', text: SPOKEN_REPLY },
    },
    {
      type: 'message_end',
      messageId: NEW_ASSISTANT_MESSAGE_ID,
      status: 'complete',
      stopReason: 'end_turn',
      usage: null,
      error: null,
    },
    { type: 'turn_end', turnId: NEW_TURN_ID, status: 'completed', error: null },
  ];
  return events.map((event, index) => frame(index + 1, event)).join('');
}

/** Everything that would reach the vendor or the model, answered here. */
async function mockVendor(page: Page): Promise<void> {
  await page.route(/\/api\/tenant\/[^/]+\/voice$/, (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'azure-speech',
        defaults: { voice: 'en-US-AvaMultilingualNeural', locale: 'en-US' },
        prefs: {
          voice: 'en-GB-SoniaNeural',
          rate: 1.25,
          autoPlay: false,
          locale: 'en-GB',
          accent: 'rainbow',
          userAccent: 'emerald',
        },
        voices: VOICES,
        voicesError: null,
      },
    })
  );
  await page.route(/\/api\/tenant\/[^/]+\/voice\/speech$/, (route) =>
    route.fulfill({ status: 200, contentType: 'audio/wav', body: SPOKEN_PIECE })
  );
  await page.route(/\/api\/tenant\/[^/]+\/voice\/transcribe/, (route) =>
    route.fulfill({ json: { text: UTTERANCE } })
  );
  await page.route(/\/api\/admin\/[^/]+\/connectors\/voice\/test$/, (route) =>
    route.fulfill({ json: { ok: true, voices: 612, locales: 153, defaultVoiceKnown: true } })
  );
  await page.route(/\/api\/tenant\/[^/]+\/chat\/chats\/[^/]+\/turns$/, (route) =>
    route.fulfill({
      status: 202,
      json: {
        turnId: NEW_TURN_ID,
        userMessageId: NEW_USER_MESSAGE_ID,
        assistantMessageId: NEW_ASSISTANT_MESSAGE_ID,
      },
    })
  );
  await page.route(/\/turns\/[^/]+\/cancel$/, (route) => route.fulfill({ json: { ok: true } }));
  await page.route(/\/turns\/[^/]+\/stream$/, async (route) => {
    // A model takes a moment: long enough for "Thinking…" to be seen.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: replyStream(),
    });
  });
}

async function shot(page: Page, testInfo: TestInfo, name: string, fullPage = true): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage,
  });
}

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
  await expect(section.getByLabel(/^Voice/)).toHaveValue('en-GB-SoniaNeural');
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
  // The composer row must not move while the bars dance: their box is
  // fixed and contained, so the message box and the buttons around it
  // sit exactly where they did before a sound was made.
  const box = page.getByLabel('Message');
  const speaker = page.getByRole('button', { name: 'Voice', exact: true });
  const [boxBefore, speakerBefore] = await Promise.all([box.boundingBox(), speaker.boundingBox()]);
  await page.getByRole('button', { name: 'Listen' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(speaker.locator('.voice-bars')).toBeVisible();
  // Several readings while the audio plays: none may have moved a thing.
  for (let sample = 0; sample < 5; sample += 1) {
    await page.waitForTimeout(150);
    expect(await box.boundingBox()).toEqual(boxBefore);
    expect(await speaker.boundingBox()).toEqual(speakerBefore);
  }
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
  // transcribed and sent, and the reply takes a moment to arrive.
  await expect(dialog.getByText(UTTERANCE)).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText('Thinking…')).toBeVisible({ timeout: 10_000 });
  await shot(page, testInfo, 'voice-08-mode-heard-thinking', false);

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
