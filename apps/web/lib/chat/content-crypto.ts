/**
 * Chat content at rest: one encrypted JSON document of content blocks per
 * message, under the same `renc1` envelope the knowledge layer uses.
 *
 * Opening is total. A row whose envelope cannot be opened (a rotated key,
 * a pre-encryption row that should not exist) renders as one text block
 * carrying `revealContent`'s marker rather than failing the page — the
 * conversation around it is still worth showing.
 */

import { contentEncryptionKey, encryptContent, revealContent } from '@renkei/crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { LlmContentBlock } from '@renkei/agent-llm';

function key(): Buffer | null {
  const result = contentEncryptionKey();
  return result.ok ? result.val : null;
}

export function sealText(text: string): Result<string, 'CONTENT_KEY'> {
  const k = key();
  if (!k) {
    return err('CONTENT_KEY' as const, {
      message: 'The content encryption key is not configured.',
    });
  }
  return ok(encryptContent(text, k));
}

export function openText(stored: string): string {
  return revealContent(stored, key());
}

export function sealBlocks(blocks: LlmContentBlock[]): Result<string, 'CONTENT_KEY'> {
  return sealText(JSON.stringify(blocks));
}

/** A stored block, validated just enough to be rendered and re-sent. */
export function parseBlock(value: unknown): LlmContentBlock | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const block: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) block[k] = v;
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? { type: 'text', text: block.text } : null;
    case 'thinking':
      return typeof block.thinking === 'string'
        ? {
            type: 'thinking',
            thinking: block.thinking,
            ...(typeof block.signature === 'string' ? { signature: block.signature } : {}),
          }
        : null;
    case 'redacted_thinking':
      return typeof block.data === 'string'
        ? { type: 'redacted_thinking', data: block.data }
        : null;
    case 'tool_use':
      return typeof block.id === 'string' && typeof block.name === 'string'
        ? { type: 'tool_use', id: block.id, name: block.name, input: block.input ?? {} }
        : null;
    case 'tool_result':
      return typeof block.toolUseId === 'string' && typeof block.content === 'string'
        ? {
            type: 'tool_result',
            toolUseId: block.toolUseId,
            content: block.content,
            ...(block.isError === true ? { isError: true } : {}),
          }
        : null;
    case 'document':
      return typeof block.mediaType === 'string' && typeof block.dataBase64 === 'string'
        ? {
            type: 'document',
            mediaType: block.mediaType,
            dataBase64: block.dataBase64,
            ...(typeof block.title === 'string' ? { title: block.title } : {}),
          }
        : null;
    case 'image':
      return typeof block.mediaType === 'string' && typeof block.dataBase64 === 'string'
        ? { type: 'image', mediaType: block.mediaType, dataBase64: block.dataBase64 }
        : null;
    default:
      return null;
  }
}

export function openBlocks(stored: string): LlmContentBlock[] {
  const text = openText(stored);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the reveal marker for an unopenable envelope, shown as-is.
    return [{ type: 'text', text }];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const block = parseBlock(entry);
    return block ? [block] : [];
  });
}
