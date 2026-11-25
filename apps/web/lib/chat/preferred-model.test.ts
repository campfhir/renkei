/**
 * The model a new chat starts on: its project's own, else (in a code
 * project) its owner's preferred code project model, else its owner's
 * preferred chat model, else none (the organization's default).
 */

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { patchChatModelPrefs, patchCodeModelPrefs } from '@renkei/user-prefs';
import { firstOffered, preferredChatModelId } from './preferred-model';

const HAIKU = '00000000-0000-4000-8000-000000000a01';
const OPUS = '00000000-0000-4000-8000-000000000a02';
const OFF = '00000000-0000-4000-8000-000000000a03';
const PAINTER = '00000000-0000-4000-8000-000000000a04';

const model = (id: string, label: string, more: Record<string, unknown> = {}) => ({
  id,
  label,
  provider: 'anthropic',
  model: label,
  base_url: null,
  settings: {},
  encrypted_secrets: 'sealed',
  enabled: true,
  is_default: false,
  created_at: new Date(),
  updated_at: new Date(),
  ...more,
});

let subject = '';
let run = 0;

async function projectOn(llmModelId: string | null): Promise<string> {
  const store = memory;
  const id = await store.chatProjects.create({
    ownerSubject: subject,
    name: 'p',
    description: null,
    toolConfig: null,
  });
  if (llmModelId) await store.chatProjects.update(id, { llmModelId });
  return id;
}

async function codeProjectOn(llmModelId: string | null): Promise<string> {
  const id = await memory.chatProjects.create({
    ownerSubject: subject,
    name: 'c',
    description: null,
    toolConfig: null,
    repo: { provider: 'github', fullName: 'acme/app', branch: null },
  });
  if (llmModelId) await memory.chatProjects.update(id, { llmModelId });
  return id;
}

let memory: ReturnType<typeof createMemoryDataStore>;

beforeEach(() => {
  subject = `auth0|prefers-${++run}`;
  memory = createMemoryDataStore();
  memory.tables.seed({
    llm_model_configs: [
      model(HAIKU, 'haiku', { is_default: true }),
      model(OPUS, 'opus'),
      model(OFF, 'off', { enabled: false }),
      model(PAINTER, 'painter', { settings: { apiSurface: 'images' } }),
    ],
  });
  registerDataStore(memory);
});

afterAll(() => resetDataStore());

describe('firstOffered', () => {
  it('takes the first pick the organization offers, skipping the unset and the gone', () => {
    expect(firstOffered([null, 'gone', 'b', 'a'], ['a', 'b'])).toBe('b');
    expect(firstOffered([null, undefined], ['a'])).toBeNull();
  });
});

describe('a new chat with no model picked for it', () => {
  it('names no model when nobody chose one: the organization default answers', async () => {
    expect(await preferredChatModelId(subject, null)).toBeNull();
    expect(await preferredChatModelId(subject, await projectOn(null))).toBeNull();
  });

  it("starts on its owner's preferred model", async () => {
    await patchChatModelPrefs(subject, { modelId: OPUS });
    expect(await preferredChatModelId(subject, null)).toBe(OPUS);
  });

  it("starts on its project's model, whatever its owner prefers", async () => {
    await patchChatModelPrefs(subject, { modelId: HAIKU });
    expect(await preferredChatModelId(subject, await projectOn(OPUS))).toBe(OPUS);
  });

  it("falls back to its owner's preference in a project with no model of its own", async () => {
    await patchChatModelPrefs(subject, { modelId: OPUS });
    expect(await preferredChatModelId(subject, await projectOn(null))).toBe(OPUS);
  });

  it('passes over a pick that was switched off or cannot answer a chat', async () => {
    await patchChatModelPrefs(subject, { modelId: OPUS });
    expect(await preferredChatModelId(subject, await projectOn(OFF))).toBe(OPUS);
    await patchChatModelPrefs(subject, { modelId: PAINTER });
    expect(await preferredChatModelId(subject, null)).toBeNull();
  });
});

describe('a new chat in a code project', () => {
  it("starts on its owner's preferred code project model, ahead of their chat model", async () => {
    await patchChatModelPrefs(subject, { modelId: HAIKU });
    await patchCodeModelPrefs(subject, { modelId: OPUS });
    expect(await preferredChatModelId(subject, await codeProjectOn(null))).toBe(OPUS);
  });

  it("starts on the project's own model, whatever its owner prefers for code", async () => {
    await patchCodeModelPrefs(subject, { modelId: HAIKU });
    expect(await preferredChatModelId(subject, await codeProjectOn(OPUS))).toBe(OPUS);
  });

  it('falls back to the chat model preference, then to the organization default', async () => {
    const project = await codeProjectOn(null);
    expect(await preferredChatModelId(subject, project)).toBeNull();
    await patchChatModelPrefs(subject, { modelId: OPUS });
    expect(await preferredChatModelId(subject, project)).toBe(OPUS);
  });

  it('passes over a code project preference the organization no longer offers', async () => {
    await patchChatModelPrefs(subject, { modelId: OPUS });
    await patchCodeModelPrefs(subject, { modelId: OFF });
    expect(await preferredChatModelId(subject, await codeProjectOn(null))).toBe(OPUS);
  });

  it('leaves chats outside a code project to the chat model preference', async () => {
    await patchChatModelPrefs(subject, { modelId: HAIKU });
    await patchCodeModelPrefs(subject, { modelId: OPUS });
    expect(await preferredChatModelId(subject, null)).toBe(HAIKU);
    expect(await preferredChatModelId(subject, await projectOn(null))).toBe(HAIKU);
  });
});
