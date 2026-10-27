/**
 * chat_rename — the model's handle on the chat's title. Offered in every
 * chat: a title is the chat's own metadata, never an organization system,
 * so it is not gated by project membership or read-only mode.
 *
 * The first prompt also gets one automatic title (autoTitleChat). It runs
 * beside the reply, is asked for once per chat (`chats.auto_title_asked`),
 * and writes no rows of its own: the person never sees the request or the
 * call, only the title in the sidebar. A rename the person asks for later
 * is an ordinary tool call in the thread.
 */

import { databaseForUnconvertedCode } from './unconverted-db';
import type { ResolvedLlm } from '@renkei/agent-llm';
import { recordLlmCall } from '@renkei/agents/runs';
import { logger } from '@/lib/logger';
import { errorResult, textResult, type LocalTool } from './local-tools';
import { claimAutoTitle, renameChatIfTitledAs, updateChat } from './store';
import { CHAT_RENAME_TOOL, cleanTitle } from './titles';

/** The first prompt, cut before it is sent to the title call. */
const TITLE_PROMPT_CHARS = 2_000;

export function chatRenameTool(): LocalTool {
  return {
    def: {
      name: CHAT_RENAME_TOOL,
      description:
        'Rename this chat: the title the sidebar shows for it. Use it when the person asks you to rename or retitle the chat. Give a short title, a few words, that names what the chat is about; it is cut to 60 characters.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The new title, a few words.' },
        },
        required: ['title'],
      },
    },
    async execute(input, context) {
      const title = typeof input.title === 'string' ? cleanTitle(input.title) : null;
      if (!title) return errorResult('Nothing to rename to: `title` is empty.');
      const renamed = await updateChat(context.subject, context.chatId, { title });
      return renamed
        ? textResult(`Renamed the chat to "${title}".`, { title })
        : errorResult('Could not rename this chat.');
    },
  };
}

const AUTO_TITLE_SYSTEM_PROMPT =
  'You title a chat from the first message someone sent in it. Call the chat_rename tool once with a short title — a few words, sentence case, naming what the chat is about, with no quotes and no trailing punctuation. Do not write anything else.';

/**
 * The chat's one automatic title, asked of the model right after its first
 * prompt. Runs beside the reply and never throws: a title that fails to
 * come back leaves the placeholder the send wrote, and the reply goes on.
 *
 * Its tokens go to the usage ledger under purpose `context_window`, not
 * `chat`: the call is not a turn, and writes no message row, so the
 * auto-compaction budget (compaction.ts reads the stored replies' usage)
 * never counts it.
 */
export async function autoTitleChat(input: {
  subject: string;
  chatId: string;
  llm: ResolvedLlm;
  firstPrompt: string;
}): Promise<void> {
  try {
    const claimed = await claimAutoTitle(input.chatId);
    if (!claimed) return;
    const startedAt = Date.now();
    const completion = await input.llm.provider.complete({
      system: AUTO_TITLE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: input.firstPrompt.slice(0, TITLE_PROMPT_CHARS) }],
        },
      ],
      tools: [chatRenameTool().def],
      toolChoice: { name: CHAT_RENAME_TOOL },
      maxTokens: input.llm.maxOutputTokens,
      ...(input.llm.temperature !== undefined ? { temperature: input.llm.temperature } : {}),
    });
    if (!completion.ok) throw new Error(completion.err.message ?? 'the model failed');
    await recordLlmCall(databaseForUnconvertedCode(), {
      subject: input.subject,
      agentId: null,
      purpose: 'context_window',
      inputTokens: completion.val.usage.inputTokens,
      outputTokens: completion.val.usage.outputTokens,
      durationMs: Date.now() - startedAt,
      ...(completion.val.usage.cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: completion.val.usage.cacheReadInputTokens }
        : {}),
      ...(completion.val.usage.cacheWriteInputTokens !== undefined
        ? { cacheWriteInputTokens: completion.val.usage.cacheWriteInputTokens }
        : {}),
      model: {
        provider: input.llm.providerName,
        model: input.llm.model,
        llmModelId: input.llm.modelConfigId,
      },
    });
    const call = completion.val.content.find(
      (block) => block.type === 'tool_use' && block.name === CHAT_RENAME_TOOL
    );
    const raw =
      call?.type === 'tool_use' &&
      typeof call.input === 'object' &&
      call.input !== null &&
      'title' in call.input &&
      typeof call.input.title === 'string'
        ? call.input.title
        : '';
    const title = cleanTitle(raw);
    if (!title) return;
    await renameChatIfTitledAs(input.chatId, claimed.placeholder, title);
  } catch (error) {
    logger.warn('chat auto title failed: {message}', {
      component: 'chat/title',
      chatId: input.chatId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
