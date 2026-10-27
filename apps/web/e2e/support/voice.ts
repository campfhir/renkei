/**
 * e2e/voice-fixtures.ts's data, written through store calls: the org's
 * speech service (as the admin form stores it), a person's own voice
 * preferences, and a chat with one completed turn so there is a reply to
 * Listen to — sealed under the chat's key the way the turn engine seals
 * it. The vendor mocks, the audio and the screenshot helpers stay in
 * e2e/voice-fixtures.ts until its specs move (it still imports `pg`, so a
 * memory spec copies what it needs from there rather than importing it).
 */

import type { APIRequestContext } from '@playwright/test';
import { keyFor } from './keys';
import { sealOrgSecret } from './secrets';
import { dataStore } from './store';

export const VOICE_CHAT_TITLE = 'Sprint retro prep';
export const VOICE_MODEL_LABEL = 'Claude Sonnet 5';
export const VOICE_MODEL_ID = '78787878-7878-4787-8787-787878787873';

export interface SeededVoiceChat {
  chatId: string;
  turnId: string;
  modelId: string;
}

/**
 * Seed the speech service (org-wide, the same values every time), the
 * person's voice preferences, and a chat of theirs with `reply` as its
 * one assistant message. The person must be enrolled (createPerson does).
 */
export async function seedVoiceChat(
  request: APIRequestContext,
  input: { subject: string; reply: string; question?: string }
): Promise<SeededVoiceChat> {
  const store = dataStore(request);

  await store.connectorConfigs.upsert({
    connector: 'voice',
    enabled: true,
    settings: {
      provider: 'azure-speech',
      region: 'eastus',
      endpoint: '',
      defaultVoice: 'en-US-AvaMultilingualNeural',
      defaultLocale: 'en-US',
    },
    encryptedSecrets: sealOrgSecret({ apiKey: 'e2e-speech-key' }),
  });
  // This person's own voice: a British voice, a touch faster than natural.
  await store.userPreferences.set(input.subject, 'voice', {
    voice: 'en-GB-SoniaNeural',
    rate: 1.25,
    autoPlay: false,
    locale: 'en-GB',
    detectLanguage: true,
    pushToTalk: false,
    accent: 'rainbow',
    userAccent: 'emerald',
  });

  // The model the chat ran on: org-wide, made once and shared after.
  const created = await store.llmModels.create(VOICE_MODEL_ID, {
    label: VOICE_MODEL_LABEL,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    baseUrl: null,
    settings: {},
    encryptedSecrets: sealOrgSecret({ apiKey: 'e2e' }),
    enabled: true,
    isDefault: false,
  });
  const modelId =
    created === 'created'
      ? VOICE_MODEL_ID
      : ((await store.llmModels.list()).find((model) => model.label === VOICE_MODEL_LABEL)?.id ??
        VOICE_MODEL_ID);

  const chatId = await store.chats.create({
    ownerSubject: input.subject,
    projectId: null,
    llmModelId: modelId,
    toolConfig: null,
    thinkingEnabled: false,
    autoMode: false,
  });
  await store.chats.update(input.subject, chatId, { title: VOICE_CHAT_TITLE });
  const chatKey = await keyFor(store, {
    kind: 'chat',
    resourceId: chatId,
    ownerSubject: input.subject,
  });

  const turnId = await store.chatThreads.createTurn({
    chatId,
    kind: 'reply',
    llmModelId: modelId,
    thinkingBudget: null,
    runner: null,
  });
  await store.chatThreads.insertMessage({
    chatId,
    turnId,
    role: 'user',
    kind: 'prompt',
    status: 'complete',
    content: chatKey.seal(
      JSON.stringify([
        { type: 'text', text: input.question ?? 'What slipped out of the OPS sprint?' },
      ])
    ),
  });
  const reply = await store.chatThreads.insertMessage({
    chatId,
    turnId,
    role: 'assistant',
    kind: 'assistant',
    status: 'complete',
    content: chatKey.seal(JSON.stringify([{ type: 'text', text: input.reply }])),
    llmModelId: modelId,
    provider: 'anthropic',
    model: 'claude-sonnet-5',
  });
  await store.chatThreads.updateMessage(reply.id, { stopReason: 'end_turn' });
  await store.chatThreads.finishTurn(turnId, {
    status: 'completed',
    error: null,
    iterations: 1,
    inputTokens: 800,
    outputTokens: 210,
  });
  await store.chats.touch(chatId, {});
  return { chatId, turnId, modelId };
}
