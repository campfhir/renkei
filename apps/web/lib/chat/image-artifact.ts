/**
 * Which stored file is the picture a given image call drew. The thread
 * holds the chat's artifacts as a flat list; a call's result sits in a
 * tool_results row, and the file the call kept carries that row's id
 * (AttachmentView.messageId). One row can answer several calls at once, so
 * among its image files the one whose name the result quotes ("Generated
 * bear.png with …") is the call's; with no such name, the row's first.
 * Pure — no database, no browser — so the thread and its tests share it.
 */

import type { AttachmentView } from './views';

export function imageArtifactFor(
  toolUseId: string,
  resultRowOf: ReadonlyMap<string, string>,
  artifacts: readonly AttachmentView[],
  resultText: string
): AttachmentView | null {
  const rowId = resultRowOf.get(toolUseId);
  if (!rowId) return null;
  const images = artifacts.filter(
    (artifact) => artifact.messageId === rowId && artifact.contentType.startsWith('image/')
  );
  return images.find((artifact) => resultText.includes(artifact.filename)) ?? images[0] ?? null;
}
