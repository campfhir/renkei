/**
 * The org's model roster as the composer's picker sees it: enabled rows
 * only, the default flagged, and whether the model takes a thinking
 * budget. Keys never leave the database.
 */

import { getDataStore } from '@renkei/db';
import type { ModelOption } from './views';

/** The context window an admin recorded in a model's settings, if it is a usable number. */
function contextWindowOf(settings: unknown): number | null {
  if (typeof settings !== 'object' || settings === null || !('contextWindow' in settings)) {
    return null;
  }
  const value: unknown = settings.contextWindow;
  return typeof value === 'number' && value > 0 ? Math.floor(value) : null;
}

export async function listChatModels(): Promise<ModelOption[]> {
  // An image generation model cannot answer chat: never in the picker.
  const rows = await getDataStore().chatModels.listChatModels();
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    provider: row.provider,
    model: row.model,
    isDefault: row.isDefault,
    supportsThinking: row.provider === 'anthropic',
    contextWindow: contextWindowOf(row.settings),
  }));
}

/** An image generation model the org has enabled, as the chat's image tool offers it. */
export interface ImageModelChoice {
  id: string;
  label: string;
  model: string;
}

export async function listImageModels(): Promise<ImageModelChoice[]> {
  const rows = await getDataStore().chatModels.listImageModels();
  return rows.map((row) => ({ id: row.id, label: row.label, model: row.model }));
}
