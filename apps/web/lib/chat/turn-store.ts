/**
 * The runner's TurnStore over the real tables — the only place the loop's
 * "append a row", "flush the row", "am I canceled", "the turn is over"
 * touch Kysely. Token spend goes to the shared ledger under purpose
 * 'chat', attributed to the person whose turn it was.
 */

import { recordLlmCall, type LlmCallModel } from '@renkei/agents/runs';
import { getOrgSettings } from '@renkei/settings';
import { logger } from '@/lib/logger';
import { after } from 'next/server';
import { createAttachment, toAttachmentView } from './attachments';
import { deferDigest, storeDigest } from './artifact-digest';
import { insertMessage, updateMessageContent } from './messages';
import {
  clearToolPermission,
  finishTurn,
  heartbeatTurn,
  readToolPermission,
  requestToolPermission,
  suspendTurn,
} from './turns';
import { notifyChatToolPermission } from './permission-notification';
import { touchChat } from './store';
import { interruptSubagentRunsOfTurn } from './subagent-runs';
import type { TurnStore } from './turn-runner';
import type { AttachmentView } from './views';
import type { ContentCipher } from './content-crypto';

/**
 * The largest file a chat keeps, read from the org's attachment limit: a
 * tool's file beyond this is not kept; the model saw what it saw. A tool
 * that reads bytes back from somewhere else to hand over
 * (chat_attach_from_sandbox) checks against it first, so it can say why
 * rather than hand over nothing.
 */
export async function chatFileMaxBytes(): Promise<number> {
  const settings = await getOrgSettings();
  return settings.ok ? settings.val.maxAttachmentBytes : 20_971_520;
}

export function createTurnStore(scope: {
  chatId: string;
  turnId: string;
  subject: string;
  /** For the permission notification's wording; null before the first reply names the chat. */
  chatTitle: string | null;
  /** The model this turn runs on, stamped on every ledger row it writes. */
  model: LlmCallModel | null;
  /** The chat's cipher: every row this turn writes is sealed under it. */
  cipher: ContentCipher;
}): TurnStore {
  return {
    async appendMessage(input) {
      const inserted = await insertMessage({
        chatId: scope.chatId,
        turnId: scope.turnId,
        role: input.role,
        kind: input.kind,
        status: input.status,
        blocks: input.blocks,
        cipher: scope.cipher,
      });
      if (!inserted) throw new Error('The content encryption key is not configured.');
      return inserted;
    },
    async flushAssistant(id, blocks, patch) {
      await updateMessageContent(id, blocks, scope.cipher, patch);
    },
    heartbeat(iterations, stage) {
      return heartbeatTurn(scope.turnId, iterations, stage);
    },
    async finishTurn(outcome) {
      await finishTurn(scope.turnId, outcome);
      // A sub-agent still marked running now has no turn to report to.
      await interruptSubagentRunsOfTurn(scope.turnId);
      await touchChat(scope.chatId, {});
    },
    async suspendTurn(iterations) {
      await suspendTurn(scope.turnId, iterations);
      // A sub-agent in flight dies with this process; the resumed turn
      // is told its delegation was interrupted and delegates again.
      await interruptSubagentRunsOfTurn(scope.turnId);
    },
    async recordUsage(usage, model, durationMs) {
      await recordLlmCall({
        subject: scope.subject,
        agentId: null,
        purpose: 'chat',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(usage.cacheReadInputTokens !== undefined
          ? { cacheReadInputTokens: usage.cacheReadInputTokens }
          : {}),
        ...(usage.cacheWriteInputTokens !== undefined
          ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
          : {}),
        // A sub-agent on a model of its own says so; everything else is the turn's.
        model: model ?? scope.model,
      });
    },
    async requestToolPermission(ask) {
      await requestToolPermission(scope.turnId, {
        toolUseId: ask.toolUseId,
        messageId: ask.messageId,
        name: ask.name,
        requestedAt: ask.requestedAt,
      });
      // Fire-and-forget: the row above is what the wait reads; this is
      // reach for a person who is not looking at the chat.
      notifyChatToolPermission({
        ownerSubject: scope.subject,
        chatId: scope.chatId,
        chatTitle: scope.chatTitle,
        toolUseId: ask.toolUseId,
        toolName: ask.name,
      });
    },
    async readToolPermission(toolUseId) {
      const record = await readToolPermission(scope.turnId, toolUseId);
      return record?.decision ?? null;
    },
    async clearToolPermission() {
      await clearToolPermission(scope.turnId);
    },
    async storeArtifacts(messageId, files) {
      const kept: AttachmentView[] = [];
      const maxBytes = await chatFileMaxBytes();
      for (const file of files) {
        const created = await createAttachment({
          ownerSubject: scope.subject,
          chatId: scope.chatId,
          filename: file.filename,
          contentType: file.mediaType,
          bytes: Buffer.from(file.dataBase64, 'base64'),
          maxBytes,
          // Tool output was redacted at the MCP boundary already.
          redactor: null,
          cipher: scope.cipher,
          key: { kind: 'chat', ref: scope.chatId },
          origin: 'model',
          messageId,
        });
        if (created.ok) {
          kept.push(toAttachmentView(created.val));
          // Its summary and keywords for the library's search: the ones
          // the model gave as it wrote the file, stored as they are; else
          // asked of the organization's model once the turn's response is
          // out of the way (or, on a turn served by no request, beside it).
          if (file.digest) await storeDigest(created.val.id, file.digest);
          else deferDigest(scope.subject, [created.val], after);
        } else if (created.err.type !== 'UNCONFIGURED') {
          logger.warn('chat artifact not stored: {reason} {message}', {
            component: 'chat/turn',
            subject: scope.subject,
            chatId: scope.chatId,
            turnId: scope.turnId,
            filename: file.filename,
            reason: created.err.type,
            message: created.err.message ?? '',
          });
        }
      }
      return kept;
    },
  };
}
