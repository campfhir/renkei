/**
 * Send: the one write path that creates a turn, and the deferred work
 * that answers it.
 *
 * `startChatTurn` does only what must happen before the response — pick
 * the model, redact and store the person's message, open the turn row
 * (the database refuses a second running turn), open the empty assistant
 * row — and hands the rest to `defer`, which defaults to Next's after():
 * the response goes out at once with the ids the page needs to start
 * listening, and the model work runs to completion behind it.
 *
 * `executeChatTurn` is that rest: resolve the person's tool surface (a
 * token minted for the turn, the app's own MCP endpoint), build the
 * prompt and history, run the loop, and whatever happens, leave the rows
 * settled and the token revoked.
 */

import { after } from 'next/server';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { resolveAgentLlm, type LlmContentBlock, type ResolvedLlm } from '@renkei/agent-llm';
import { getOrgSettings, type OrgSettings } from '@renkei/settings';
import { sandboxConfig } from '@renkei/sandbox-client';
import { tenantBlobStoreConfigured } from '@renkei/blob-store';
import { logger } from '@/lib/logger';
import { getIdentityDisplay } from '@/lib/identity';
import { isUuid } from '@/lib/uuid';
import { resolveChatAccess } from './access';
import { listMessages, insertMessage } from './messages';
import { createTurn, finishTurn } from './turns';
import { touchChat, type ChatRow } from './store';
import { getProjectRow } from './projects';
import { deriveTitle } from './titles';
import { createOutboundRedactor } from './outbound-redaction';
import { buildHistory, buildSystemPrompt } from './request-builder';
import { effectiveToolConfig } from './tool-config';
import { getDefaultChatTools } from './tool-prefs';
import { resolveChatToolSurface } from './tool-surface';
import { createLocalToolSet, type LocalTool } from './local-tools';
import { findToolsTool } from './tool-discovery';
import { openTurnChannel } from './turn-events';
import { createTurnStore } from './turn-store';
import { runChatTurn, DEFAULT_TURN_LIMITS } from './turn-runner';
import { chatLocalTools } from './chat-local-tools';
import { readProjectMemory, renderProjectMemory } from './memory';

export const USER_MESSAGE_MAX_CHARS = 100_000;

/**
 * Thinking spends part of the output budget; keep room for the answer.
 * Only the older Anthropic models take a budget — the 4.6-and-later
 * generations decide their own depth, and the adapter turns the switch
 * into adaptive thinking with its summary returned instead.
 */
const THINKING_SHARE = 0.6;
const THINKING_MAX = 16_000;

export type StartTurnError =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'EMPTY'
  | 'TOO_LONG'
  | 'ALREADY_RUNNING'
  | 'NO_MODEL'
  | 'MODEL_ERROR'
  | 'CONTENT_KEY'
  | 'DB_ERROR';

export interface StartedTurn {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
}

export interface StartTurnInput {
  tenantId: string;
  session: { subject: string; roles: string[] };
  chatId: string;
  text: string;
  /** Extra blocks a caller adds behind the text (attachment excerpts). */
  extraBlocks?: LlmContentBlock[];
  /** Attachment ids to link to the prompt row (Phase 5). */
  attachmentIds?: string[];
  llmModelId?: string | null;
  defer?: (task: () => Promise<void>) => void;
}

export async function startChatTurn(
  db: Kysely<DB>,
  input: StartTurnInput
): Promise<Result<StartedTurn, StartTurnError>> {
  const defer = input.defer ?? ((task) => after(task));
  const text = input.text.trim();
  if (!text && (input.extraBlocks ?? []).length === 0) return err('EMPTY' as const);
  if (text.length > USER_MESSAGE_MAX_CHARS) return err('TOO_LONG' as const);

  const access = await resolveChatAccess(db, input.tenantId, input.session.subject, input.chatId);
  if (!access) return err('NOT_FOUND' as const);
  if (access.role !== 'owner') return err('FORBIDDEN' as const);
  const chat = access.chat;

  const requestedModel =
    input.llmModelId !== undefined && input.llmModelId !== null && isUuid(input.llmModelId)
      ? input.llmModelId
      : (chat.llmModelId ?? null);
  const llmResult = await resolveAgentLlm(db, input.tenantId, requestedModel);
  if (!llmResult.ok) {
    return err(
      llmResult.err.type === 'NO_MODEL' ? ('NO_MODEL' as const) : ('MODEL_ERROR' as const),
      {
        message: llmResult.err.message,
      }
    );
  }
  const llm = llmResult.val;

  const settingsResult = await getOrgSettings(input.tenantId);
  const settings = settingsResult.ok ? settingsResult.val : null;
  const redactor = settings ? createOutboundRedactor(input.tenantId, settings) : null;
  const redacted = redactor ? redactor.apply(text) : { text, counts: {} };
  const userBlocks: LlmContentBlock[] = [
    ...(redacted.text ? [{ type: 'text' as const, text: redacted.text }] : []),
    ...(input.extraBlocks ?? []),
  ];

  const thinkingBudget =
    chat.thinkingEnabled && llm.providerName === 'anthropic'
      ? Math.min(THINKING_MAX, Math.floor(llm.maxOutputTokens * THINKING_SHARE))
      : null;

  let started: StartedTurn;
  try {
    const opened = await db.transaction().execute(async (trx) => {
      const turn = await createTurn(trx, {
        tenantId: input.tenantId,
        chatId: chat.id,
        llmModelId: llm.modelConfigId,
        thinkingBudget,
      });
      if (!turn.ok) return turn;
      const user = await insertMessage(trx, {
        tenantId: input.tenantId,
        chatId: chat.id,
        turnId: turn.val,
        role: 'user',
        kind: 'prompt',
        status: 'complete',
        blocks: userBlocks,
      });
      if (!user) return err('CONTENT_KEY' as const);
      const assistant = await insertMessage(trx, {
        tenantId: input.tenantId,
        chatId: chat.id,
        turnId: turn.val,
        role: 'assistant',
        kind: 'assistant',
        status: 'streaming',
        blocks: [],
        llmModelId: llm.modelConfigId,
        provider: llm.providerName,
        model: llm.model,
      });
      if (!assistant) return err('CONTENT_KEY' as const);
      if (input.attachmentIds && input.attachmentIds.length > 0) {
        await trx
          .updateTable('chat_attachments')
          .set({ message_id: user.id })
          .where('tenant_id', '=', input.tenantId)
          .where('chat_id', '=', chat.id)
          .where('owner_subject', '=', input.session.subject)
          .where('id', 'in', input.attachmentIds.filter(isUuid))
          .execute();
      }
      await touchChat(trx, chat.id, {
        titleIfMissing: deriveTitle(text || 'Attachment'),
        // The switch is sticky: the chat remembers the model it last used.
        llmModelId: llm.modelConfigId,
      });
      return ok({
        turnId: turn.val,
        userMessageId: user.id,
        assistantMessageId: assistant.id,
        assistantSeq: assistant.seq,
        assistantCreatedAt: assistant.createdAt,
      });
    });
    if (!opened.ok) {
      return err(
        opened.err.type === 'ALREADY_RUNNING'
          ? ('ALREADY_RUNNING' as const)
          : opened.err.type === 'CONTENT_KEY'
            ? ('CONTENT_KEY' as const)
            : ('DB_ERROR' as const)
      );
    }
    started = {
      turnId: opened.val.turnId,
      userMessageId: opened.val.userMessageId,
      assistantMessageId: opened.val.assistantMessageId,
    };
    const assistantRow = {
      id: opened.val.assistantMessageId,
      seq: opened.val.assistantSeq,
      createdAt: opened.val.assistantCreatedAt,
    };
    defer(() =>
      executeChatTurn(db, {
        tenantId: input.tenantId,
        session: input.session,
        chat: { ...chat, llmModelId: llm.modelConfigId },
        turnId: started.turnId,
        assistantMessage: assistantRow,
        llm,
        thinkingBudget,
        settings,
      })
    );
  } catch (error) {
    logger.warn('chat turn could not start: {error}', {
      component: 'chat/turn',
      tenantId: input.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return err('DB_ERROR' as const);
  }
  return ok(started);
}

export interface ExecuteTurnInput {
  tenantId: string;
  session: { subject: string; roles: string[] };
  chat: ChatRow;
  turnId: string;
  assistantMessage: { id: string; seq: number; createdAt: Date };
  llm: ResolvedLlm;
  thinkingBudget: number | null;
  settings: OrgSettings | null;
  localTools?: LocalTool[];
}

export async function executeChatTurn(db: Kysely<DB>, input: ExecuteTurnInput): Promise<void> {
  const channel = openTurnChannel(input.turnId);
  const store = createTurnStore(db, {
    tenantId: input.tenantId,
    chatId: input.chat.id,
    turnId: input.turnId,
    subject: input.session.subject,
  });
  const log = (message: string, fields: Record<string, unknown>) =>
    logger.warn(message, {
      component: 'chat/turn',
      tenantId: input.tenantId,
      chatId: input.chat.id,
      turnId: input.turnId,
      ...fields,
    });

  let release: () => Promise<void> = async () => {};
  try {
    const project = input.chat.projectId
      ? await getProjectRow(db, input.tenantId, input.chat.projectId)
      : null;
    // Only consulted when neither the chat nor the project has its own
    // toolset, so a cache miss here never costs a chat that already has one.
    const userDefault =
      input.chat.toolConfig || project?.toolConfig
        ? null
        : await getDefaultChatTools(input.tenantId, input.session.subject);
    const toolConfig = effectiveToolConfig(
      input.chat.toolConfig,
      project?.toolConfig ?? null,
      userDefault
    );
    const surface = await resolveChatToolSurface(db, {
      tenantId: input.tenantId,
      subject: input.session.subject,
      roles: input.session.roles,
      config: toolConfig,
      ttlSeconds: Math.ceil(DEFAULT_TURN_LIMITS.wallClockMs / 1000) + 15 * 60,
    });
    release = surface.release;

    const readOnly = input.settings?.readOnly ?? false;
    const localContext = {
      db,
      tenantId: input.tenantId,
      subject: input.session.subject,
      chatId: input.chat.id,
      projectId: input.chat.projectId,
      readOnly,
    };
    const filesAllowed = await tenantBlobStoreConfigured(input.tenantId);
    const baseLocalTools =
      input.localTools ?? (await chatLocalTools(db, localContext, toolConfig, filesAllowed));
    const discoveryTool = findToolsTool(surface.discoverable);
    const localTools = createLocalToolSet(
      discoveryTool ? [...baseLocalTools, discoveryTool] : baseLocalTools
    );

    const [rows, person] = await Promise.all([
      listMessages(db, input.tenantId, input.chat.id),
      getIdentityDisplay(input.tenantId, input.session.subject),
    ]);
    const history = buildHistory(
      rows,
      {
        turnId: input.turnId,
        llmModelId: input.llm.modelConfigId,
        providerName: input.llm.providerName,
      },
      input.assistantMessage.id
    );
    const context = await chatPromptContext(db, input.tenantId, input.chat, project);
    const system = buildSystemPrompt({
      personName: person?.displayName ?? person?.email ?? null,
      orgName: null,
      project: context.project,
      chatFiles: context.chatFiles,
      hasTools: surface.tools.length > 0 || localTools.defs().length > 0,
      hasKnowledge: surface.tools.some((tool) => tool.name === 'search_knowledge'),
      hasSandbox: toolConfig.connectors.includes('sandbox') && sandboxConfig() !== null,
      filesAllowed,
      now: new Date(),
    });

    await runChatTurn(
      {
        llm: input.llm,
        tools: [...surface.tools, ...localTools.defs()].sort((a, b) =>
          a.name.localeCompare(b.name)
        ),
        mcp: surface.mcp,
        localTools,
        localContext,
        readOnlyTools: new Set([...surface.readOnlyTools, ...localTools.readOnlyNames()]),
        channel,
        store,
        log,
      },
      {
        turnId: input.turnId,
        assistantMessage: input.assistantMessage,
        system,
        history,
        thinkingBudget: input.thinkingBudget,
      }
    );
  } catch (error) {
    log('chat turn failed before the model ran: {message}', {
      message: error instanceof Error ? error.message : String(error),
    });
    try {
      await store.flushAssistant(input.assistantMessage.id, [], {
        status: 'failed',
        error: 'The reply could not be started.',
      });
      await finishTurn(db, input.turnId, {
        status: 'failed',
        error: 'The reply could not be started.',
        iterations: 0,
        inputTokens: 0,
        outputTokens: 0,
      });
    } catch {
      // The janitor marks it interrupted.
    }
    channel.emit({
      type: 'turn_end',
      turnId: input.turnId,
      status: 'failed',
      error: 'The reply could not be started.',
    });
    channel.close();
  } finally {
    await release();
  }
}

/** What the system prompt says about the project and the files at hand. */
export async function chatPromptContext(
  db: Kysely<DB>,
  tenantId: string,
  chat: ChatRow,
  project: Awaited<ReturnType<typeof getProjectRow>>
): Promise<{
  project: Parameters<typeof buildSystemPrompt>[0]['project'];
  chatFiles: Parameters<typeof buildSystemPrompt>[0]['chatFiles'];
}> {
  const files = await db
    .selectFrom('chat_attachments')
    .select(['id', 'filename', 'content_type', 'size_bytes', 'chat_id', 'project_id'])
    .where('tenant_id', '=', tenantId)
    .where((eb) =>
      eb.or([eb('chat_id', '=', chat.id), ...(project ? [eb('project_id', '=', project.id)] : [])])
    )
    .orderBy('created_at', 'asc')
    .execute();
  const shape = (row: (typeof files)[number]) => ({
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
  });
  return {
    project: project
      ? {
          name: project.name,
          instructions: project.instructions,
          memoryText: await projectMemoryText(db, tenantId, project.id),
          files: files.filter((row) => row.project_id === project.id).map(shape),
        }
      : null,
    chatFiles: files.filter((row) => row.chat_id === chat.id).map(shape),
  };
}

async function projectMemoryText(
  db: Kysely<DB>,
  tenantId: string,
  projectId: string
): Promise<string | null> {
  return renderProjectMemory(await readProjectMemory(db, tenantId, projectId));
}
