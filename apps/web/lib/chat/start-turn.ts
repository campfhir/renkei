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
import {
  resolveAgentLlm,
  type LlmContentBlock,
  type LlmUsage,
  type ResolvedLlm,
} from '@renkei/agent-llm';
import { getOrgSettings, type OrgSettings } from '@renkei/settings';
import { sandboxConfig } from '@renkei/sandbox-client';
import { CODE_TURN_LIMITS, codeProjectContext } from '@/lib/code/turn';
import { CODE_DELEGATE_TOOL } from '@/lib/code/delegate';
import { tenantBlobStoreConfigured } from '@renkei/blob-store';
import { logger } from '@/lib/logger';
import { getIdentityDisplay } from '@/lib/identity';
import { isUuid } from '@/lib/uuid';
import { resolveChatAccess } from './access';
import { compactChat, latestChatSummary, needsCompaction } from './compaction';
import { listMessages, insertMessage, type InsertedMessage } from './messages';
import { createTurn, finishTurn } from './turns';
import { touchChat, type ChatRow } from './store';
import { getProjectRow } from './projects';
import { deriveTitle } from './titles';
import { createOutboundRedactor } from './outbound-redaction';
import { buildHistory, buildSystemPrompt } from './request-builder';
import { CODE_PROJECT_EAGER_TOOLS, effectiveToolConfig, projectToolConfig } from './tool-config';
import { getDefaultChatTools } from './tool-prefs';
import { getChatToolPermissionPrefs } from './permission-prefs';
import { resolveChatToolSurface } from './tool-surface';
import { createLocalToolSet, type LocalTool } from './local-tools';
import { findToolsTool, recallDiscoveredTools } from './tool-discovery';
import { openTurnChannel } from './turn-events';
import { createTurnStore } from './turn-store';
import { runChatTurn, DEFAULT_TURN_LIMITS } from './turn-runner';
import { chatLocalTools } from './chat-local-tools';
import {
  AUTO_MAX_CONTINUES,
  AUTO_NUDGE_TEXT,
  TASK_COMPLETE_TOOL,
  taskCompleteTool,
} from './auto-mode';
import { readProjectMemory, renderProjectMemory } from './memory';
import { readUserMemory, renderUserMemory } from './user-memory';
import { notifyChatReplyDesktop } from './reply-notification';
import { createSubagentRecorder } from './subagent-runs';

/**
 * The hard ceiling on one Send: past this, even chunking is refused (an
 * abuse/DoS guard, not a working limit — see PASTE_CHUNK_CHARS below).
 */
export const USER_MESSAGE_MAX_CHARS = 1_000_000;

/**
 * A paste past this size is split across several `prompt` rows rather than
 * stored as one giant message — matches attachments.ts's INLINE_EXCERPT_CHARS,
 * so a huge paste and a huge file excerpt land at the same working size.
 * Chunk boundaries prefer the last newline so a chunk rarely cuts mid-line,
 * but the chunks always concatenate back to the original text exactly:
 * resend.ts's unedited-resend path depends on that to reconstruct it.
 */
const PASTE_CHUNK_CHARS = 40_000;

/** Splits `text` on newlines near `chunkChars`; chunks.join('') === text always. */
export function splitPaste(text: string, chunkChars: number): string[] {
  if (text.length <= chunkChars) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkChars, text.length);
    if (end < text.length) {
      const lastBreak = text.lastIndexOf('\n', end);
      if (lastBreak > start + chunkChars * 0.5) end = lastBreak + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * One block array per `prompt` row: a single row when the text fits (today's
 * shape, unchanged), otherwise one row per chunk with the extra blocks
 * (attachment excerpts) riding the last one — same place they always sat,
 * right after the person's own text.
 */
function chunkedUserBlocks(text: string, extraBlocks: LlmContentBlock[]): LlmContentBlock[][] {
  const chunks = text ? splitPaste(text, PASTE_CHUNK_CHARS) : [];
  if (chunks.length <= 1) {
    return [[...(chunks[0] ? [{ type: 'text' as const, text: chunks[0] }] : []), ...extraBlocks]];
  }
  return chunks.map((chunk, index) => [
    { type: 'text' as const, text: chunk },
    ...(index === chunks.length - 1 ? extraBlocks : []),
  ]);
}

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
  /** The message came from a voice conversation; the reply is written to be heard. */
  voice?: boolean;
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
      let user: InsertedMessage | null = null;
      for (const blocks of chunkedUserBlocks(redacted.text, input.extraBlocks ?? [])) {
        const inserted = await insertMessage(trx, {
          tenantId: input.tenantId,
          chatId: chat.id,
          turnId: turn.val,
          role: 'user',
          kind: 'prompt',
          status: 'complete',
          blocks,
        });
        if (!inserted) return err('CONTENT_KEY' as const);
        user = inserted;
      }
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
        voice: input.voice === true,
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
  /** See StartTurnInput.voice. */
  voice?: boolean;
}

export async function executeChatTurn(db: Kysely<DB>, input: ExecuteTurnInput): Promise<void> {
  const channel = openTurnChannel(input.turnId);
  const store = createTurnStore(db, {
    tenantId: input.tenantId,
    chatId: input.chat.id,
    turnId: input.turnId,
    subject: input.session.subject,
    chatTitle: input.chat.title,
    model: {
      provider: input.llm.providerName,
      model: input.llm.model,
      llmModelId: input.llm.modelConfigId,
    },
  });
  const log = (
    message: string,
    fields: Record<string, unknown>,
    level: 'debug' | 'warn' = 'warn'
  ) =>
    logger[level](message, {
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
    const defaultsKind = project?.kind === 'code' ? 'code' : 'chat';
    // Only consulted when neither the chat nor the project has its own
    // toolset, so a cache miss here never costs a chat that already has
    // one. A code project's chat reads the person's code-project default,
    // never their chat default (tool-prefs.ts keeps the two apart).
    const userDefault =
      input.chat.toolConfig || project?.toolConfig
        ? null
        : await getDefaultChatTools(input.tenantId, input.session.subject, {
            kind: defaultsKind,
          });
    // A code project's chats always carry the Bitbucket connector on top
    // of whatever was chosen (tool-config.ts): the code_* tools push, the
    // connector's tools open the pull request.
    const toolConfig = projectToolConfig(
      effectiveToolConfig(
        input.chat.toolConfig,
        project?.toolConfig ?? null,
        userDefault,
        defaultsKind
      ),
      project?.kind
    );
    // A code project's turn is a working session with far higher limits
    // than an ordinary chat's (lib/code/turn.ts); the tool surface lives
    // as long as the turn may.
    const limits = project?.kind === 'code' ? CODE_TURN_LIMITS : undefined;
    const wallClockMs = limits?.wallClockMs ?? DEFAULT_TURN_LIMITS.wallClockMs;
    // The token must outlive the longest the turn can run: its wall clock
    // plus every minute it may spend parked behind a permission ask.
    const permissionWaitMs = limits?.permissionWaitMs ?? DEFAULT_TURN_LIMITS.permissionWaitMs;
    // fresh: "always allow" clicked in another chat a moment ago, or a tool
    // just blocked on the Preferences page, must hold for this turn too.
    const permissionPrefs = await getChatToolPermissionPrefs(
      input.tenantId,
      input.session.subject,
      { fresh: true }
    );
    const denied = new Set(permissionPrefs.alwaysDeny);
    const surface = await resolveChatToolSurface(db, {
      tenantId: input.tenantId,
      subject: input.session.subject,
      roles: input.session.roles,
      config: toolConfig,
      ttlSeconds: Math.ceil((wallClockMs + permissionWaitMs) / 1000) + 15 * 60,
      excluded: denied,
      // A code chat is told to open the pull request by name: those tools
      // are offered up front rather than behind find_tools.
      ...(defaultsKind === 'code' ? { eager: { tools: CODE_PROJECT_EAGER_TOOLS } } : {}),
    });
    release = surface.release;

    const readOnly = input.settings?.readOnly ?? false;
    const [initialRows, person] = await Promise.all([
      listMessages(db, input.tenantId, input.chat.id),
      getIdentityDisplay(input.tenantId, input.session.subject),
    ]);
    // Compaction runs before history is built, not as a background sweep:
    // the guarantee is that THIS turn's request stays bounded. A failed or
    // unavailable model leaves every message as it was for the next turn's
    // check to retry — never a reason to fail the turn that triggered it.
    let rows = initialRows;
    if (needsCompaction(rows)) {
      try {
        const compacted = await compactChat(db, {
          tenantId: input.tenantId,
          chatId: input.chat.id,
          llm: input.llm,
          createdBy: 'auto',
          messages: rows,
          onProgress: (progress) =>
            channel.emit({ type: 'compaction_progress', turnId: input.turnId, ...progress }),
        });
        if (compacted) rows = await listMessages(db, input.tenantId, input.chat.id);
        // The pass's own end, so the thread's card does not take a reply
        // that fails later for a fold that did not.
        channel.emit({
          type: 'compaction_progress',
          turnId: input.turnId,
          foldedSoFar: compacted?.foldedCount ?? 0,
          totalToFold: compacted?.foldedCount ?? 0,
          status: 'done',
        });
      } catch (error) {
        log('chat auto-compaction failed: {message}', {
          message: error instanceof Error ? error.message : String(error),
        });
        channel.emit({
          type: 'compaction_progress',
          turnId: input.turnId,
          foldedSoFar: 0,
          totalToFold: 0,
          status: 'failed',
        });
      }
    }
    const chatSummary = await latestChatSummary(db, input.tenantId, input.chat.id);
    const localContext = {
      db,
      tenantId: input.tenantId,
      subject: input.session.subject,
      chatId: input.chat.id,
      projectId: input.chat.projectId,
      userEmail: person?.email ?? null,
      readOnly,
      llm: input.llm,
      recordUsage: (usage: LlmUsage) => store.recordUsage(usage),
      emitProgress: (progress: { foldedSoFar: number; totalToFold: number }) =>
        channel.emit({ type: 'compaction_progress', turnId: input.turnId, ...progress }),
      // A code chat's sub-agents keep their runs (subagent-runs.ts) and
      // report progress on the turn's stream; nothing of theirs enters
      // this turn's history but the report.
      ...(project?.kind === 'code'
        ? {
            subagents: createSubagentRecorder(
              db,
              { tenantId: input.tenantId, chatId: input.chat.id, turnId: input.turnId },
              (subagent) =>
                channel.emit({ type: 'subagent_progress', turnId: input.turnId, subagent }),
              log
            ),
          }
        : {}),
    };
    const filesAllowed = await tenantBlobStoreConfigured(input.tenantId);
    // A code project's checkout, when it is there to work in: the code_*
    // tools bound to it, and what the prompt says about it either way.
    const code =
      project?.kind === 'code'
        ? await codeProjectContext(db, project, { subject: input.session.subject })
        : null;
    // Auto mode (auto-mode.ts) is a code project's way of working: its
    // tools run unasked and the turn carries on until task_complete.
    // Read off the chat row the turn started from, so a switch flipped
    // mid-turn takes effect on the next Send, never halfway through.
    const auto = project?.kind === 'code' && input.chat.autoMode && !readOnly;
    // A blocked local tool is withheld the same way a blocked connector
    // tool is: the model is never offered a verb it may not use.
    const baseLocalTools = (
      input.localTools ?? [
        ...(await chatLocalTools(db, localContext, toolConfig, filesAllowed)),
        ...(code?.tools ?? []),
        ...(auto ? [taskCompleteTool()] : []),
      ]
    ).filter((tool) => !denied.has(tool.def.name));
    const discoveryTool = findToolsTool(surface.discoverable);
    const localTools = createLocalToolSet(
      discoveryTool ? [...baseLocalTools, discoveryTool] : baseLocalTools
    );

    const history = buildHistory(
      rows,
      {
        turnId: input.turnId,
        llmModelId: input.llm.modelConfigId,
        providerName: input.llm.providerName,
      },
      input.assistantMessage.id,
      // A code chat's context is for coordinating: earlier turns' tool
      // results are trimmed to their head (request-builder.ts), and the
      // brief says to call again rather than recall.
      { elideEarlierToolResults: project?.kind === 'code' }
    );
    // What earlier turns found through find_tools stays offered: the model
    // calls a tool it remembers whether or not its schema is in the request,
    // and only with the schema does it call it right.
    const recalled = recallDiscoveredTools(history, surface.discoverable);
    const context = await chatPromptContext(db, input.tenantId, input.chat, project);
    const system = buildSystemPrompt({
      personName: person?.displayName ?? person?.email ?? null,
      orgName: null,
      project: context.project ? { ...context.project, code: code?.prompt ?? null } : null,
      userMemoryText: context.userMemoryText,
      chatSummary: chatSummary?.content ?? null,
      chatFiles: context.chatFiles,
      hasTools: surface.tools.length > 0 || localTools.defs().length > 0,
      hasDiscoverableTools: discoveryTool !== null,
      hasKnowledge: surface.tools.some((tool) => tool.name === 'search_knowledge'),
      voice: input.voice === true,
      // outlook_search_users is a `microsoft` tool, not a core connector, so
      // it is almost always in `discoverable` rather than offered up front —
      // the brief has to work whichever bucket it is in.
      hasDirectory:
        surface.tools.some((tool) => tool.name === 'outlook_search_users') ||
        surface.discoverable.some((entry) => entry.def.name === 'outlook_search_users'),
      hasSandbox: toolConfig.connectors.includes('sandbox') && sandboxConfig() !== null,
      filesAllowed,
      autoMode: auto,
      now: new Date(),
    });

    const outcome = await runChatTurn(
      {
        llm: input.llm,
        tools: [...surface.tools, ...recalled, ...localTools.defs()].sort((a, b) =>
          a.name.localeCompare(b.name)
        ),
        mcp: surface.mcp,
        localTools,
        localContext,
        readOnlyTools: new Set([...surface.readOnlyTools, ...localTools.readOnlyNames()]),
        discoverableTools: surface.discoverable.map((entry) => entry.def),
        // Every call that acts asks first, unless this person has said
        // "always" for that tool (permission-prefs.ts) — or the chat is in
        // auto mode, where nothing asks and only a blocked tool refuses.
        permissions: {
          alwaysAllowed: new Set(permissionPrefs.alwaysAllow),
          denied,
          ...(auto ? { allowAll: true } : {}),
        },
        ...(auto
          ? {
              autoContinue: {
                doneTool: TASK_COMPLETE_TOOL,
                nudge: AUTO_NUDGE_TEXT,
                maxContinues: AUTO_MAX_CONTINUES,
                subagentTool: CODE_DELEGATE_TOOL,
              },
            }
          : {}),
        channel,
        store,
        log,
        ...(limits ? { limits } : {}),
      },
      {
        turnId: input.turnId,
        assistantMessage: input.assistantMessage,
        system,
        history,
        thinkingBudget: input.thinkingBudget,
        ...(code?.prelude ? { prelude: [code.prelude] } : {}),
      }
    );
    // Only a reply that actually landed is news — a canceled or interrupted
    // turn is the person's own doing, and a failure has nothing to page
    // them about. Only the owner can ever start a turn, so they're the
    // only one waiting on it.
    if (outcome.status === 'completed') {
      notifyChatReplyDesktop({
        tenantId: input.tenantId,
        ownerSubject: input.session.subject,
        chatId: input.chat.id,
        chatTitle: input.chat.title,
      });
    }
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
  userMemoryText: Parameters<typeof buildSystemPrompt>[0]['userMemoryText'];
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
          code: null,
        }
      : null,
    userMemoryText: project
      ? null
      : renderUserMemory(await readUserMemory(db, tenantId, chat.ownerSubject)),
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
