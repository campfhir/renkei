/**
 * The model a new chat starts on when nobody picked one for it: its
 * project's own (a chat project or a code project), else its owner's
 * preferred chat model, else none — which every reader takes as the
 * organization's default. A pick the organization no longer offers (the
 * model was disabled, or is not a chat model) is passed over, so a stale
 * choice never leaves a chat on a model that cannot answer.
 */

import { getDataStore } from '@renkei/db';
import { getChatModelPrefs } from '@renkei/user-prefs';

/** The first of these picks, in order, that names a model on offer. */
export function firstOffered(
  picks: readonly (string | null | undefined)[],
  offered: readonly string[]
): string | null {
  return picks.find((pick) => pick && offered.includes(pick)) ?? null;
}

export async function preferredChatModelId(
  ownerSubject: string,
  projectId: string | null
): Promise<string | null> {
  const store = getDataStore();
  const [project, prefs] = await Promise.all([
    projectId ? store.chatProjects.get(projectId) : null,
    // fresh: the Preferences page saves through another module graph, and
    // "I just picked this" must hold for the very next chat.
    getChatModelPrefs(ownerSubject, { fresh: true }),
  ]);
  const picks = [project?.llmModelId ?? null, prefs.modelId];
  if (picks.every((pick) => !pick)) return null;
  const offered = (await store.chatModels.listChatModels()).map((model) => model.id);
  return firstOffered(picks, offered);
}
