/**
 * The whole result of one tool call, as the agent read it, for the run page.
 *
 * A turn's `toolCalls` carry a 2,000-character `resultPreview`; the sealed
 * `results` beside them keep each tool_result whole (the 30,000 characters
 * the model was given, fenced as untrusted data). A call recorded with its
 * `toolUseId` is matched to its result and shown in full, frame removed;
 * one recorded before the id was kept — or a sub-agent's, whose results
 * are not stored — falls back to the preview.
 */

import { unfenceUntrusted } from '@renkei/agents';
import { isRecord } from '@renkei/guards';

/** A tool_result's content as text: a string, or its text blocks joined. */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.flatMap((block) =>
    isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  );
  return texts.length > 0 ? texts.join('\n') : null;
}

const PREVIEW_MARKER = /… \[truncated\]$/;

export function toolResultText(
  detail: Record<string, unknown>,
  call: Record<string, unknown>
): string | null {
  const preview =
    typeof call.resultPreview === 'string' && call.resultPreview ? call.resultPreview : null;
  if (typeof call.toolUseId !== 'string' || !Array.isArray(detail.results)) return preview;
  const stored = detail.results.find(
    (result) => isRecord(result) && result.toolUseId === call.toolUseId
  );
  const text = isRecord(stored) ? contentText(stored.content) : null;
  if (text === null) return preview;
  const full = unfenceUntrusted(text);
  // Never show less than the preview did.
  return !preview || full.length >= preview.replace(PREVIEW_MARKER, '').length ? full : preview;
}
