/**
 * Resend a prompt — as it was, or edited — and start over from there.
 *
 * Everything from that prompt on is removed first: the rows of its turn
 * and every later turn, the turns themselves, and the files those
 * replies produced (their bytes too, best effort, after the rows are
 * gone). The prompt's own uploads survive: deleting their message only
 * unlinks them, and the new turn links them again. Then it is Send as
 * usual, through `startChatTurn`.
 *
 * The removal and the new turn are two steps, not one transaction: the
 * new turn runs after the response and cannot be inside it. Should Send
 * fail after the removal (no model, say), the chat is left truncated at
 * the prompt — a state the person can see and continue from.
 */

import { getDataStore } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { resolveTenantBlobStore } from '@renkei/blob-store';
import { logger } from '@/lib/logger';
import { isUuid } from '@/lib/uuid';
import { resolveChatAccess } from './access';
import { openBlocks, type ContentCipher } from './content-crypto';
import { getActiveTurn } from './turns';
import { startChatTurn, type StartTurnError, type StartedTurn } from './start-turn';

export type ResendError = StartTurnError | 'NOT_PROMPT';

export interface ResendInput {
  session: { subject: string; roles: string[] };
  chatId: string;
  messageId: string;
  /** The edited text; null resends the prompt as it was. */
  text: string | null;
  /** Uploads made while editing, on top of the prompt's own. */
  extraAttachmentIds?: string[];
  llmModelId?: string | null;
  /** See StartTurnInput.voice: the corrected words of a voice utterance. */
  voice?: boolean;
  /** See StartTurnInput.timeZone. */
  timeZone?: string | null;
  defer?: (task: () => Promise<void>) => void;
}

export interface Resent extends StartedTurn {
  /** The resent prompt's old seq: rows from here on were removed. */
  fromSeq: number;
  /** Files tools produced in the removed replies, no longer listed. */
  removedArtifactIds: string[];
}

/** A stored row's first text block, without the attachment excerpts riding behind it, untrimmed. */
function rawPromptText(content: string, cipher: ContentCipher): string {
  const blocks = openBlocks(content, cipher);
  const first = blocks.find((block) => block.type === 'text');
  if (!first || first.type !== 'text') return '';
  return first.text.replace(/<attachment [^>]*>[\s\S]*?<\/attachment>/g, '');
}

/** The typed text of a stored prompt: its first text block, without the attachment excerpts. */
export function promptTextOf(content: string, cipher: ContentCipher): string {
  return rawPromptText(content, cipher).trim();
}

/**
 * A resend-as-is has to see the WHOLE original paste, not just the row the
 * person clicked: start-turn.ts's chunkedUserBlocks splits a large paste
 * across several `prompt` rows sharing one turn_id, in seq order, and their
 * chunks concatenate back to the original text exactly (no separator, and
 * untrimmed here so a chunk boundary mid-whitespace survives) — trimmed
 * only once, at the end, matching a single-row prompt's own trim. A row
 * with no turn (an older chat) falls back to its own text.
 */
async function originalPromptText(
  chatId: string,
  prompt: { turnId: string | null; content: string },
  cipher: ContentCipher
): Promise<string> {
  if (!prompt.turnId) return promptTextOf(prompt.content, cipher);
  const rows = (await getDataStore().chatThreads.listTurnMessages(prompt.turnId)).filter(
    (row) => row.chatId === chatId && row.role === 'user' && row.kind === 'prompt'
  );
  if (rows.length === 0) return promptTextOf(prompt.content, cipher);
  return rows
    .map((row) => rawPromptText(row.content, cipher))
    .join('')
    .trim();
}

export async function resendFromMessage(input: ResendInput): Promise<Result<Resent, ResendError>> {
  if (!isUuid(input.messageId)) return err('NOT_FOUND' as const);
  const access = await resolveChatAccess(input.session.subject, input.chatId);
  if (!access) return err('NOT_FOUND' as const);
  if (access.role !== 'owner') return err('FORBIDDEN' as const);
  if (await getActiveTurn(access.chat.id)) return err('ALREADY_RUNNING' as const);

  const store = getDataStore();
  const prompt = await store.chatThreads.getMessage(access.chat.id, input.messageId);
  if (!prompt) return err('NOT_FOUND' as const);
  if (prompt.kind !== 'prompt') return err('NOT_PROMPT' as const);

  const text =
    input.text !== null
      ? input.text
      : await originalPromptText(access.chat.id, prompt, access.cipher);
  const ownUploads = (
    await store.artifacts.listByChat(access.chat.id, { origin: 'upload' })
  ).filter((row) => row.messageId === prompt.id);
  const attachmentIds = [
    ...ownUploads.map((row) => row.id),
    ...(input.extraAttachmentIds ?? []).filter(isUuid),
  ];

  const removed = await store.chatThreads.truncateFrom(access.chat.id, prompt.seq);
  const removedBlobKeys = removed.map((row) => row.blobKey);
  const removedArtifactIds = removed.map((row) => row.id);
  if (removedBlobKeys.length > 0) {
    const store = await resolveTenantBlobStore();
    if (store.ok) {
      for (const key of removedBlobKeys) {
        const deleted = await store.val.deleteObject(key);
        if (!deleted.ok && deleted.err.type !== 'NOT_FOUND') {
          // The retention sweep cannot see an orphan; say so where someone can.
          logger.warn('chat artifact blob not deleted: {key} {reason}', {
            key,
            reason: deleted.err.type,
          });
        }
      }
    }
  }

  const started = await startChatTurn({
    session: input.session,
    chatId: access.chat.id,
    text,
    attachmentIds,
    llmModelId: input.llmModelId ?? null,
    voice: input.voice === true,
    timeZone: input.timeZone ?? null,
    defer: input.defer,
  });
  if (!started.ok) return started;
  return ok({ ...started.val, fromSeq: prompt.seq, removedArtifactIds });
}
