/**
 * Chat content at rest: one encrypted JSON document of content blocks per
 * message.
 *
 * Two envelopes, one reader. A chat with a key of its own
 * (`resource_keys`, migration 133; lib/chat/chat-keys.ts) seals under that
 * key as `renc2:<key id>:…` — the per-chat, per-person model described in
 * docs/user-encryption-keys-design.md. Rows from before a chat had a key
 * are `renc1` envelopes under the deployment content key, and every
 * cipher here still opens those, so a chat is readable through the
 * rollout and re-sealed by its next write or the rekey sweep.
 *
 * A `ContentCipher` is what a caller threads through: `legacyCipher` is
 * the deployment key alone (what every seal did before keys, and what the
 * tables not yet keyed — project instructions, memories, attachment
 * text — still use); `resourceCipher(key)` seals under a chat's key.
 *
 * Opening is total. A row whose envelope cannot be opened (a rotated key,
 * a chat key this cipher does not hold, a pre-encryption row that should
 * not exist) renders as one text block carrying a marker rather than
 * failing the page — the conversation around it is still worth showing.
 */

import {
  contentEncryptionKey,
  decryptWithResourceKey,
  encryptContent,
  encryptWithResourceKey,
  isEncryptedContent,
  isResourceEncrypted,
  parseResourceEnvelope,
  revealContent,
} from '@renkei/crypto';
import type { ResourceKey } from '@renkei/user-keys';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { LlmContentBlock } from '@renkei/agent-llm';

function key(): Buffer | null {
  const result = contentEncryptionKey();
  return result.ok ? result.val : null;
}

/** How one chat's (or table's) content is sealed and opened. */
export interface ContentCipher {
  /** The resource key this cipher seals under, or null for the deployment key alone. */
  readonly keyId: string | null;
  seal(text: string): Result<string, 'CONTENT_KEY'>;
  open(stored: string): string;
}

function sealLegacy(text: string): Result<string, 'CONTENT_KEY'> {
  const k = key();
  if (!k) {
    return err('CONTENT_KEY' as const, {
      message: 'The content encryption key is not configured.',
    });
  }
  return ok(encryptContent(text, k));
}

/** A `renc1` row opened under the deployment key; anything else, a marker. */
function openLegacy(stored: string): string {
  if (isResourceEncrypted(stored)) {
    return "[content unavailable: this chat's key was not opened]";
  }
  return revealContent(stored, key());
}

/**
 * The deployment content key alone — every row written before chats had
 * keys, and the tables that are not keyed yet.
 */
export const legacyCipher: ContentCipher = {
  keyId: null,
  seal: sealLegacy,
  open: openLegacy,
};

/**
 * A chat's own key: seals `renc2` under it; opens `renc2` rows sealed
 * under it and `renc1` rows from before the chat had one.
 */
export function resourceCipher(resource: ResourceKey): ContentCipher {
  return {
    keyId: resource.id,
    seal: (text) => ok(encryptWithResourceKey(text, resource.id, resource.key)),
    open: (stored) => {
      if (!isResourceEncrypted(stored)) return revealContent(stored, key());
      const opened = decryptWithResourceKey(stored, resource.id, resource.key);
      if (opened.ok) return opened.val;
      const names = parseResourceEnvelope(stored)?.keyId;
      return opened.err.type === 'WRONG_KEY'
        ? `[content unavailable: sealed under another key${names ? ` (${names.slice(0, 8)}…)` : ''}]`
        : '[content unavailable: decryption failed]';
    },
  };
}

/** Whether a stored value is any envelope this module knows — `renc1` or `renc2`. */
export function isSealed(stored: string): boolean {
  return isEncryptedContent(stored) || isResourceEncrypted(stored);
}

export function sealText(
  text: string,
  cipher: ContentCipher = legacyCipher
): Result<string, 'CONTENT_KEY'> {
  return cipher.seal(text);
}

export function openText(stored: string, cipher: ContentCipher = legacyCipher): string {
  return cipher.open(stored);
}

/**
 * A column that was plaintext before it was sealed (chat_summaries.content
 * predates both envelopes): an envelope opens, anything else is the text
 * itself. Only for columns with that history — everywhere else a bare
 * value is an error (`openText`), never a passthrough.
 */
export function openStoredText(stored: string, cipher: ContentCipher): string {
  return isSealed(stored) ? cipher.open(stored) : stored;
}

export function sealBlocks(
  blocks: LlmContentBlock[],
  cipher: ContentCipher = legacyCipher
): Result<string, 'CONTENT_KEY'> {
  return sealText(JSON.stringify(blocks), cipher);
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
        ? {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input ?? {},
            ...(typeof block.partialJson === 'string' ? { partialJson: block.partialJson } : {}),
          }
        : null;
    case 'tool_result':
      return typeof block.toolUseId === 'string' && typeof block.content === 'string'
        ? {
            type: 'tool_result',
            toolUseId: block.toolUseId,
            content: block.content,
            ...(block.isError === true ? { isError: true } : {}),
            ...(typeof block.uiResourceUri === 'string'
              ? { uiResourceUri: block.uiResourceUri }
              : {}),
            ...('structuredContent' in block ? { structuredContent: block.structuredContent } : {}),
            ...(typeof block.durationMs === 'number' ? { durationMs: block.durationMs } : {}),
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

export function openBlocks(
  stored: string,
  cipher: ContentCipher = legacyCipher
): LlmContentBlock[] {
  const text = openText(stored, cipher);
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
