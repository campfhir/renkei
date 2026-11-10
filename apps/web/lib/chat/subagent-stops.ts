/**
 * Stopping one sub-agent, from outside its loop: the person presses Stop
 * on a sub-agent that is still working (the run's modal, `POST
 * …/subagents/[toolUseId]/stop`), whatever the rest of the turn is doing.
 *
 * Two roads, both taken. The run's row is marked interrupted with who
 * stopped it — the loop reads the row before each model call
 * (subagent.ts, through its recorder) and stops when it is no longer
 * running, so a sub-agent on another replica stops at its next step. And
 * when the loop runs in this process its model call in flight is aborted
 * at once, through the controller it registered here.
 */

import { getDataStore } from '@renkei/db';

declare global {
  var __renkeiSubagentStops: Map<string, AbortController> | undefined;
}

// On globalThis: the route that stops and the turn that runs may sit in
// different server bundles of the one process.
function stops(): Map<string, AbortController> {
  globalThis.__renkeiSubagentStops ??= new Map();
  return globalThis.__renkeiSubagentStops;
}

const keyOf = (chatId: string, toolUseId: string) => `${chatId}:${toolUseId}`;

/** A running loop makes itself stoppable; the answer takes it off the list again. */
export function watchSubagentStop(
  chatId: string,
  toolUseId: string,
  controller: AbortController
): () => void {
  const key = keyOf(chatId, toolUseId);
  stops().set(key, controller);
  return () => {
    if (stops().get(key) === controller) stops().delete(key);
  };
}

/**
 * Ask a sub-agent to stop. True when one was still running (marked on its
 * row, or found working here); false when there was nothing left to stop.
 */
export async function stopSubagent(
  chatId: string,
  toolUseId: string,
  reason: string
): Promise<boolean> {
  const marked = await getDataStore().chatThreads.stopSubagentRun(chatId, toolUseId, reason);
  const here = stops().get(keyOf(chatId, toolUseId));
  here?.abort();
  return marked || here !== undefined;
}
