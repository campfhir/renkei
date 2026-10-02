/**
 * Chat content at rest: one encrypted JSON document of content blocks per
 * message, and every other sealed column of the chat's tables.
 *
 * One rule: a row is sealed under the KEY OF THE THING IT BELONGS TO, and
 * under nothing else (docs/user-encryption-keys-design.md). A chat's
 * messages, summaries, sub-agent runs and files are under the chat's key
 * (`renc2:<key id>:…`); a project's instructions, memory and files under
 * the project's key (the same envelope); a person's own memory directly
 * under that person's key (`uenc1:…`). There is no deployment-wide key
 * for any of it any more, so a `ContentCipher` is never optional: every
 * seal and open takes one, and the key behind it is the whole access
 * story.
 *
 * Opening is total. A row the cipher cannot open — sealed under another
 * key, under a key that is locked, or in a form from before keys — renders
 * as one text block carrying a marker rather than failing the page; the
 * conversation around it is still worth showing, and the marker says
 * which case it is.
 */

import {
  decryptWithResourceKey,
  encryptWithResourceKey,
  isResourceEncrypted,
  parseResourceEnvelope,
} from '@renkei/crypto';
import type { ResourceKey } from '@renkei/user-keys';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { LlmContentBlock } from '@renkei/agent-llm';

/** Why a cipher has no key to work with. */
export type CipherUnavailable =
  /** The owner is on their own key and has not unlocked it. */
  | 'locked'
  /** The resource has no key (not yet re-sealed by the sweep) or none could be opened. */
  | 'no-key'
  /** The delegate, the one process that holds keys, could not be reached. */
  | 'delegate';

/** How one chat's, project's or person's content is sealed and opened. */
export interface ContentCipher {
  /** The resource key this cipher seals under; null for a person's own key and for an unavailable cipher. */
  readonly keyId: string | null;
  /** Set when there is no key: sealing fails and opening yields a marker. */
  readonly unavailable: CipherUnavailable | null;
  seal(text: string): Result<string, 'CONTENT_KEY'>;
  open(stored: string): string;
}

const MARKERS = {
  locked: '[content unavailable: your encryption key is locked — unlock it in Preferences]',
  'no-key': '[content unavailable: no key for this content — run the rekey sweep]',
  delegate: '[content unavailable: the key service could not be reached — try again shortly]',
  legacy: '[content unavailable: sealed under the retired deployment key — run the rekey sweep]',
  other: '[content unavailable: sealed under another key]',
  failed: '[content unavailable: decryption failed]',
};

/**
 * A chat's or project's own key: seals `renc2` under it and opens only
 * rows sealed under it.
 */
export function resourceCipher(resource: ResourceKey): ContentCipher {
  return {
    keyId: resource.id,
    unavailable: null,
    seal: (text) => ok(encryptWithResourceKey(text, resource.id, resource.key)),
    open: (stored) => {
      if (!isResourceEncrypted(stored)) return MARKERS.legacy;
      const opened = decryptWithResourceKey(stored, resource.id, resource.key);
      if (opened.ok) return opened.val;
      if (opened.err.type === 'WRONG_KEY') {
        const names = parseResourceEnvelope(stored)?.keyId;
        return `${MARKERS.other.slice(0, -1)}${names ? ` (${names.slice(0, 8)}…)` : ''}]`;
      }
      return MARKERS.failed;
    },
  };
}

/** The marker a row renders as when it cannot be opened for the given reason. */
export function unavailableMarker(reason: CipherUnavailable | 'failed'): string {
  return MARKERS[reason];
}

/**
 * No key to work with: every seal fails closed and every open is the
 * marker for why. Reads stay total; writes cannot land under a wrong key.
 */
export function unavailableCipher(reason: CipherUnavailable): ContentCipher {
  const message =
    reason === 'locked'
      ? 'Your encryption key is locked. Unlock it in Preferences to continue.'
      : reason === 'delegate'
        ? 'The key service could not be reached. Try again shortly.'
        : 'No encryption key is available for this content.';
  return {
    keyId: null,
    unavailable: reason,
    seal: () => err('CONTENT_KEY' as const, { message }),
    open: () => MARKERS[reason],
  };
}

export function sealText(text: string, cipher: ContentCipher): Result<string, 'CONTENT_KEY'> {
  return cipher.seal(text);
}

export function openText(stored: string, cipher: ContentCipher): string {
  return cipher.open(stored);
}

export function sealBlocks(
  blocks: LlmContentBlock[],
  cipher: ContentCipher
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

export function openBlocks(stored: string, cipher: ContentCipher): LlmContentBlock[] {
  const text = openText(stored, cipher);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: the marker for an unopenable envelope, shown as-is.
    return [{ type: 'text', text }];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const block = parseBlock(entry);
    return block ? [block] : [];
  });
}
