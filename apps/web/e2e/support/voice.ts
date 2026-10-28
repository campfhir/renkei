/**
 * What the voice specs share, staged the way the app writes it: the org's
 * speech service through the admin Voice form's route (PUT
 * /api/admin/connectors/voice), this person's own voice through
 * Preferences (PUT /api/preferences), and a chat with one reply to Listen
 * to, asked of the stand-in model, scripted in the prompt (./stub-model.ts). The vendor —
 * the voice catalog, synthesis, transcription — and the turn an utterance
 * becomes are answered at the browser edge (`mockVendor`), with the audio
 * the mocked synthesis returns.
 *
 * The speech service is organization-wide and every voice spec needs it
 * on, side by side, so it is written the same each time and left on (as
 * the Postgres suite's seed left it): one spec turning it off would pull
 * it out from under another mid-test. The caller must be an operator.
 */

import path from 'node:path';
import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { addStubModel, scripted } from './stub-model';
import { createChat, send } from './chat';

export const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results');

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
function spokenSamples(rate: number): Float32Array {
  const samples = new Float32Array(rate * 4);
  for (let index = 0; index < samples.length; index += 1) {
    const t = index / rate;
    const syllables = 0.55 + 0.45 * Math.sin(2 * Math.PI * 3.1 * t);
    samples[index] = 0.35 * syllables * Math.sin(2 * Math.PI * 180 * t);
  }
  return samples;
}
export const SPOKEN_PIECE = wav(spokenSamples(16_000), 16_000);
/**
 * The same four seconds as the raw 24 kHz samples a piece played as it
 * arrives is asked for (`format: 'pcm'`, lib/voice/speech-queue.ts): a
 * WAV's data chunk without its header.
 */
export const SPOKEN_PIECE_PCM = wav(spokenSamples(24_000), 24_000).subarray(44);

/** The ids of the turn an utterance becomes: the mocked turn's, never stored. */
export const NEW_TURN_ID = '78787878-7878-4787-8787-787878787874';
export const NEW_USER_MESSAGE_ID = '78787878-7878-4787-8787-787878787875';
export const NEW_ASSISTANT_MESSAGE_ID = '78787878-7878-4787-8787-787878787876';
const MOCKED_MODEL_ID = '78787878-7878-4787-8787-787878787873';
export const CHAT_TITLE = 'Sprint retro prep';
export const QUESTION = 'What slipped out of the OPS sprint?';
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

/** This person's own voice: a British voice, a touch faster than natural. */
export const VOICE_PREFS = {
  voice: 'en-GB-SoniaNeural',
  rate: 1.25,
  autoPlay: false,
  locale: 'en-GB',
  detectLanguage: true,
  pushToTalk: false,
  accent: 'rainbow',
  userAccent: 'emerald',
};

export interface VoiceChat {
  chatId: string;
  modelId: string;
}

/** The org's speech service on, as the admin form saves it. */
export async function enableVoiceService(request: APIRequestContext): Promise<void> {
  const saved = await request.put('/api/admin/connectors/voice', {
    data: {
      provider: 'azure-speech',
      region: 'eastus',
      endpoint: '',
      defaultVoice: 'en-US-AvaMultilingualNeural',
      defaultLocale: 'en-US',
      apiKey: 'e2e-speech-key',
      enabled: true,
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  // The org's connector settings are read through a short cache (a built
  // app holds them for a while): wait until the service is offered, as
  // the page's own voice route reads it.
  await expect
    .poll(
      async () => {
        const offered = await request.get('/api/voice');
        return offered.ok() ? Boolean((await offered.json()).configured) : false;
      },
      { timeout: 90_000, intervals: [1_000, 2_000, 5_000] }
    )
    .toBe(true);
}

/**
 * The speech service, this person's voice, and a chat with one completed
 * turn so there is a reply to Listen to. Remove the model with
 * removeModel(request, modelId) afterwards.
 */
export async function stageVoice(request: APIRequestContext, tag: string): Promise<VoiceChat> {
  await enableVoiceService(request);
  const prefs = await request.put('/api/preferences', { data: { voice: VOICE_PREFS } });
  expect(prefs.ok(), await prefs.text()).toBe(true);
  const modelId = await addStubModel(request, tag, { label: `Claude Sonnet 5 ${tag}` });
  const chatId = await createChat(request, { llmModelId: modelId, title: CHAT_TITLE });
  await send(request, chatId, scripted(QUESTION, [{ text: REPLY_MARKDOWN }]), modelId);
  return { chatId, modelId };
}

/**
 * Wait until the chat and Preferences pages offer voice. Each server
 * bundle keeps its own minute-long cache of the org's connector settings
 * (@renkei/connector-config), so a page rendered just before the service
 * was switched on can go on leaving voice out for up to that minute.
 */
export async function untilVoiceOffered(page: Page, chatId: string): Promise<void> {
  for (const [url, offered] of [
    [`/chat/${chatId}`, () => page.getByRole('button', { name: 'Voice', exact: true })],
    ['/preferences', () => page.getByRole('region', { name: 'Voice' })],
  ] as const) {
    await expect(async () => {
      await page.goto(url);
      await expect(offered()).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 90_000, intervals: [2_000, 5_000] });
  }
}

export const VOICES = [
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
      llmModelId: MOCKED_MODEL_ID,
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
      llmModelId: MOCKED_MODEL_ID,
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

export async function mockVendor(
  page: Page,
  options: {
    asks?: boolean;
    /** How long the model "takes" before the plain reply streams; the default is long enough for "Thinking…" to be seen. */
    replyDelayMs?: number;
    /**
     * What the recognizer says the utterance was when asked which
     * language it was in (`?detect=1`), a moment after the quick answer
     * in the set language has already gone out as a message.
     */
    heard?: { locale: string; text: string };
  } = {}
): Promise<void> {
  await page.route(/\/api\/voice$/, (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'azure-speech',
        defaults: { voice: 'en-US-AvaMultilingualNeural', locale: 'en-US' },
        prefs: VOICE_PREFS,
        voices: VOICES,
        voicesError: null,
      },
    })
  );
  await page.route(/\/api\/voice\/speech$/, (route) => {
    const body: unknown = route.request().postDataJSON();
    const pcm = typeof body === 'object' && body !== null && Reflect.get(body, 'format') === 'pcm';
    return pcm
      ? route.fulfill({ status: 200, contentType: 'audio/pcm', body: SPOKEN_PIECE_PCM })
      : route.fulfill({ status: 200, contentType: 'audio/wav', body: SPOKEN_PIECE });
  });
  await page.route(/\/api\/voice\/transcribe/, async (route) => {
    const detecting = route.request().url().includes('detect=1');
    if (detecting && options.heard) {
      // The slower answer: behind the quick one, as the vendor's is.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return route.fulfill({ json: options.heard });
    }
    return route.fulfill({ json: { text: UTTERANCE } });
  });
  await page.route(/\/api\/admin\/connectors\/voice\/test$/, (route) =>
    route.fulfill({ json: { ok: true, voices: 612, locales: 153, defaultVoiceKnown: true } })
  );
  await page.route(/\/api\/chat\/chats\/[^/]+\/turns$/, (route) =>
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
  // A corrected utterance is resent from its message: the same new turn
  // again, with the wrong words' row (seq 3, after the two staged) and
  // everything after it removed.
  await page.route(/\/messages\/[^/]+\/resend$/, (route) =>
    route.fulfill({
      status: 202,
      json: {
        turnId: NEW_TURN_ID,
        userMessageId: NEW_USER_MESSAGE_ID,
        assistantMessageId: NEW_ASSISTANT_MESSAGE_ID,
        fromSeq: 3,
        removedArtifactIds: [],
      },
    })
  );
  if (!options.asks) {
    await page.route(/\/turns\/[^/]+\/stream$/, async (route) => {
      // A model takes a moment: long enough for "Thinking…" to be seen.
      await new Promise((resolve) => setTimeout(resolve, options.replyDelayMs ?? 4_000));
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
  // The furthest event served: a reconnect whose Last-Event-ID the route
  // does not see (Chromium adds it below the interception) resumes there.
  let served = 0;
  await page.route(/\/turns\/[^/]+\/stream$/, async (route) => {
    const header = route.request().headers()['last-event-id'];
    const after = header ? Number(header) : served;
    // What the browser has seen decides the stage — the page may open
    // more than one source for a turn, so a connection count would not.
    // A model takes a moment, and so does a search: each stage is held
    // long enough to be seen (the reconnect itself adds the browser's retry).
    const stage = decided ? 2 : after >= asking.stages[0] ? 1 : 0;
    if (stage < 2) await new Promise((resolve) => setTimeout(resolve, 2_500));
    const upTo = asking.stages[stage];
    served = Math.max(served, upTo);
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
