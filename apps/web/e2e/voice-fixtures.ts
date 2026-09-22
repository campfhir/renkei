/**
 * What the voice specs share: the fixtures seeded into the database (the
 * org's speech service, this person's preferences, a chat with a reply),
 * the vendor and model answered at the browser edge, and the audio the
 * mocked synthesis returns. voice.spec.ts drives the whole feature in
 * Chromium (whose fake microphone can be fed a file); voice-webkit.spec.ts
 * reuses these to check the read-aloud path in WebKit, the engine an
 * iPhone actually runs.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import path from 'node:path';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import type { VoiceInfo } from '@renkei/voice';
import { E2E_SUBJECT, E2E_TENANT_ID } from './seed';

export const RESULTS = path.join(import.meta.dirname, '..', 'test-results');

/** A 16-bit mono PCM WAV of the samples. */
export function wav(samples: Float32Array, sampleRate: number): Buffer {
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
export const SPOKEN_PIECE = spokenPiece();

export const CHAT_ID = '78787878-7878-4787-8787-787878787871';
export const TURN_ID = '78787878-7878-4787-8787-787878787872';
export const MODEL_ID = '78787878-7878-4787-8787-787878787873';
export const NEW_TURN_ID = '78787878-7878-4787-8787-787878787874';
export const NEW_USER_MESSAGE_ID = '78787878-7878-4787-8787-787878787875';
export const NEW_ASSISTANT_MESSAGE_ID = '78787878-7878-4787-8787-787878787876';
export const CHAT_TITLE = 'Sprint retro prep';
export const UTTERANCE = 'Which issues slipped out of the last sprint, and who owns them?';
export const SPOKEN_REPLY =
  'Two issues slipped out of the last sprint. OPS-41, rotating the Zoom webhook secret, is still ' +
  'in progress with Priya. OPS-44, backfilling the file share index, has not been started and is ' +
  'assigned to Marcus. Both are still open; shall I move them into the next sprint for you?';

export const REPLY_MARKDOWN = [
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

/**
 * The voice fixtures, delete-then-insert like the rest of the seed. Every
 * voice spec seeds them in its own beforeAll, and Playwright runs spec
 * files on parallel workers, so the whole seed is one transaction under
 * an advisory lock: two seeders run one after the other and each finds
 * the rows the other left, never half of them.
 */
export async function seedVoice(client: Client): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('e2e:voice-seed'))");
    await seedVoiceRows(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function seedVoiceRows(client: Client): Promise<void> {
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
        detectLanguage: true,
        pushToTalk: false,
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

export const VOICES: VoiceInfo[] = [
  {
    id: 'en-US-AvaMultilingualNeural',
    name: 'Ava Multilingual',
    locale: 'en-US',
    gender: 'female',
    description: 'Friendly, positive · conversation, copilot',
    multilingual: true,
  },
  {
    id: 'en-US-AndrewMultilingualNeural',
    name: 'Andrew Multilingual',
    locale: 'en-US',
    gender: 'male',
    description: 'Warm, confident · conversation, copilot',
    multilingual: true,
  },
  {
    id: 'en-US-EmmaNeural',
    name: 'Emma',
    locale: 'en-US',
    gender: 'female',
    description: 'Cheerful, clear · conversation, customer service',
    multilingual: false,
  },
  {
    id: 'en-GB-SoniaNeural',
    name: 'Sonia',
    locale: 'en-GB',
    gender: 'female',
    description: 'Calm, pleasant · narration, news',
    multilingual: false,
  },
  {
    id: 'en-GB-RyanNeural',
    name: 'Ryan',
    locale: 'en-GB',
    gender: 'male',
    description: null,
    multilingual: false,
  },
  {
    id: 'en-AU-NatashaNeural',
    name: 'Natasha',
    locale: 'en-AU',
    gender: 'female',
    description: null,
    multilingual: false,
  },
  {
    id: 'de-DE-KatjaNeural',
    name: 'Katja',
    locale: 'de-DE',
    gender: 'female',
    description: 'Friendly · conversation',
    multilingual: false,
  },
  {
    id: 'fr-FR-DeniseNeural',
    name: 'Denise',
    locale: 'fr-FR',
    gender: 'female',
    description: null,
    multilingual: false,
  },
  {
    id: 'es-ES-ElviraNeural',
    name: 'Elvira',
    locale: 'es-ES',
    gender: 'female',
    description: null,
    multilingual: false,
  },
  {
    id: 'ja-JP-NanamiNeural',
    name: 'Nanami (七海)',
    locale: 'ja-JP',
    gender: 'female',
    description: 'Warm, gentle · conversation, narration',
    multilingual: false,
  },
  {
    id: 'zh-CN-XiaoxiaoNeural',
    name: 'Xiaoxiao (晓晓)',
    locale: 'zh-CN',
    gender: 'female',
    description: 'Lively, warm · news, novel',
    multilingual: false,
  },
];

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

/**
 * The reply as a turn that works first and then asks: a search call the
 * page sees start (announced in voice mode), then an act call the runner
 * parks behind a permission ask, and — once the owner answers — the
 * reply itself. Revealed in stages, one per connection: EventSource
 * reconnects after the body ends and sends Last-Event-ID, which is
 * honoured, so nothing is replayed.
 */
const SEARCH_TOOL_USE_ID = 'toolu_e2e_search';
const CREATE_TOOL_USE_ID = 'toolu_e2e_create';

function askingStream(): { events: Record<string, unknown>[]; stages: number[] } {
  const createdAt = new Date().toISOString();
  const message = NEW_ASSISTANT_MESSAGE_ID;
  const events: Record<string, unknown>[] = [
    {
      type: 'message_start',
      messageId: message,
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
      messageId: message,
      index: 0,
      block: { type: 'tool_use', id: SEARCH_TOOL_USE_ID, name: 'jira_search_issues', input: {} },
    },
    {
      type: 'block_stop',
      messageId: message,
      index: 0,
      block: {
        type: 'tool_use',
        id: SEARCH_TOOL_USE_ID,
        name: 'jira_search_issues',
        input: { jql: 'sprint in closedSprints() AND status != Done' },
      },
    },
    {
      type: 'tool_call_start',
      messageId: message,
      toolUseId: SEARCH_TOOL_USE_ID,
      name: 'jira_search_issues',
    },
    // ---- stage 1 ends: searching
    {
      type: 'block_start',
      messageId: message,
      index: 1,
      block: { type: 'tool_use', id: CREATE_TOOL_USE_ID, name: 'jira_create_issue', input: {} },
    },
    {
      type: 'block_stop',
      messageId: message,
      index: 1,
      block: {
        type: 'tool_use',
        id: CREATE_TOOL_USE_ID,
        name: 'jira_create_issue',
        input: { project: 'OPS', summary: 'Follow up the two slipped issues' },
      },
    },
    {
      type: 'tool_permission_request',
      turnId: NEW_TURN_ID,
      permission: {
        toolUseId: CREATE_TOOL_USE_ID,
        messageId: message,
        name: 'jira_create_issue',
        requestedAt: createdAt,
      },
    },
    // ---- stage 2 ends: asking
    {
      type: 'tool_permission_decided',
      turnId: NEW_TURN_ID,
      toolUseId: CREATE_TOOL_USE_ID,
      decision: 'once',
    },
    { type: 'block_start', messageId: message, index: 2, block: { type: 'text', text: '' } },
    { type: 'text_delta', messageId: message, index: 2, text: SPOKEN_REPLY },
    {
      type: 'block_stop',
      messageId: message,
      index: 2,
      block: { type: 'text', text: SPOKEN_REPLY },
    },
    {
      type: 'message_end',
      messageId: message,
      status: 'complete',
      stopReason: 'end_turn',
      usage: null,
      error: null,
    },
    { type: 'turn_end', turnId: NEW_TURN_ID, status: 'completed', error: null },
  ];
  return { events, stages: [4, 7, events.length] };
}

export async function mockVendor(page: Page, options: { asks?: boolean } = {}): Promise<void> {
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
          detectLanguage: true,
          pushToTalk: false,
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
  if (!options.asks) {
    await page.route(/\/turns\/[^/]+\/stream$/, async (route) => {
      // A model takes a moment: long enough for "Thinking…" to be seen.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: replyStream(),
      });
    });
    return;
  }
  const asking = askingStream();
  let decided = false;
  await page.route(/\/turns\/[^/]+\/permission$/, (route) => {
    decided = true;
    return route.fulfill({ json: { ok: true, decision: 'once' } });
  });
  await page.route(/\/turns\/[^/]+\/stream$/, async (route) => {
    const after = Number(route.request().headers()['last-event-id'] ?? '0');
    // What the browser has seen decides the stage — the page may open
    // more than one source for a turn, so a connection count would not.
    // A model takes a moment, and so does a search: each stage is held
    // long enough to be seen (the reconnect itself adds the browser's retry).
    const stage = decided ? 2 : after >= asking.stages[0] ? 1 : 0;
    if (stage < 2) await new Promise((resolve) => setTimeout(resolve, 2_500));
    const upTo = asking.stages[stage];
    const body = asking.events
      .map((event, index) => ({ event, id: index + 1 }))
      .filter(({ id }) => id > after && id <= upTo)
      .map(({ event, id }) => frame(id, event))
      .join('');
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body,
    });
  });
}

export async function shot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  fullPage = true
): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage,
  });
}

/**
 * Where the composer sits while a reply is read: the message box and the
 * speaker button must not move by a pixel while the bars dance. Shared so
 * every engine gets the same measurement.
 */
export async function expectComposerStillWhileReading(page: Page): Promise<void> {
  const box = page.getByLabel('Message');
  const speaker = page.getByRole('button', { name: 'Voice', exact: true });
  // Not before the page has hydrated: the box sizes itself to its content
  // in an effect on mount (composer.tsx's grow), and a measurement taken
  // before that would blame the bars for a change that was the box's own.
  await expect.poll(() => box.evaluate((element) => element.style.height)).toMatch(/px$/);
  const [boxBefore, speakerBefore] = await Promise.all([box.boundingBox(), speaker.boundingBox()]);
  await page.getByRole('button', { name: 'Listen' }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await expect(speaker.locator('.voice-bars')).toBeVisible();
  // Several readings while the audio plays: none may have moved a thing.
  for (let sample = 0; sample < 8; sample += 1) {
    await page.waitForTimeout(150);
    expect(await box.boundingBox()).toEqual(boxBefore);
    expect(await speaker.boundingBox()).toEqual(speakerBefore);
  }
}
