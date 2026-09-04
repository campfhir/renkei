/**
 * From stored rows to the request a model accepts.
 *
 * The system prompt is assembled from what the chat is (its project's
 * instructions and memory, the files at hand, the person) and a short
 * standing brief. The history is the chat's rows in order, with the
 * repairs a provider insists on: thinking blocks only travel back to the
 * model that signed them and only within the turn that produced them;
 * a tool call must be answered by a result in the next message or it is
 * dropped; empty text blocks and empty messages are not sent.
 */

import type { LlmContentBlock, LlmMessage } from '@renkei/agent-llm';
import type { StoredMessage } from './messages';

export interface SystemPromptInput {
  personName: string | null;
  orgName: string | null;
  project: {
    name: string;
    instructions: string | null;
    memoryText: string | null;
    files: { id: string; filename: string; contentType: string; sizeBytes: number }[];
  } | null;
  chatFiles: { id: string; filename: string; contentType: string; sizeBytes: number }[];
  hasTools: boolean;
  hasSandbox: boolean;
  /** The org has somewhere to keep files; false means none can be made or attached. */
  filesAllowed: boolean;
  now: Date;
}

const STANDING_BRIEF = `You are Renkei, an assistant inside an organization's own workspace. You answer in the person's language, plainly and specifically. When a tool would ground an answer in the organization's real data — a ticket, a document, a message, a file — use it rather than guessing; say what you looked at. Never invent identifiers, links or quotes. Format replies in Markdown: short paragraphs, lists for parallel items, fenced code for code, tables only for tabular data. Do not narrate your process or restate the question.`;

function fileLine(file: { id: string; filename: string; contentType: string; sizeBytes: number }) {
  return `- ${file.filename} (${file.contentType}, ${Math.round(file.sizeBytes / 1024)} KB, attachment id ${file.id})`;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const sections: string[] = [STANDING_BRIEF];
  const who: string[] = [];
  if (input.personName) who.push(`You are talking with ${input.personName}.`);
  if (input.orgName) who.push(`The organization is ${input.orgName}.`);
  who.push(`The current date and time is ${input.now.toISOString()} (UTC).`);
  sections.push(who.join(' '));

  if (input.project) {
    const project: string[] = [`This chat belongs to the project "${input.project.name}".`];
    if (input.project.instructions) {
      project.push(`Project instructions:\n${input.project.instructions}`);
    }
    if (input.project.memoryText) {
      project.push(
        `Project memory (notes kept across this project's chats, newest last):\n${input.project.memoryText}`
      );
    }
    if (input.project.files.length > 0) {
      project.push(
        `Project files (read one with chat_read_attachment, or stage it into the sandbox with chat_attach_to_sandbox):\n${input.project.files.map(fileLine).join('\n')}`
      );
    }
    sections.push(project.join('\n\n'));
  }
  if (input.chatFiles.length > 0) {
    sections.push(
      `Files attached to this chat (their text, when it could be extracted, is inline in the messages; read the rest with chat_read_attachment):\n${input.chatFiles.map(fileLine).join('\n')}`
    );
  }
  if (input.hasTools) {
    sections.push(
      input.hasSandbox
        ? "Tools act with this person's own permissions in the organization's systems. The sandbox_* tools give you a scratch space and a browser for files and pages no other tool reaches."
        : "Tools act with this person's own permissions in the organization's systems."
    );
  }
  if (input.filesAllowed) {
    sections.push(
      'To hand the person a file, write it with chat_write_file; it appears under this chat’s Artifacts, where they can download it or copy it to a connected network share. You write text and the extension decides the file: .csv, .md, .txt, .json and other text formats are kept as written; .docx and .pdf are rendered from your Markdown; .pptx from Markdown with a # or ## heading per slide; .xlsx from CSV, JSON sheets or Markdown tables. So an Excel workbook, a Word document, a PDF or a slide deck is yours to make — write the content, never bytes or base64. A file another tool hands back (a screenshot, a mail attachment) is kept there the same way.'
    );
  } else {
    sections.push(
      'This organization has no file storage set up. Do not produce files of any kind — no screenshots, exports, rendered documents or downloads — and do not offer to; answer in text. If a task needs a file, say that file storage is not set up and an operator can add it under Organization → Storage.'
    );
  }
  return sections.join('\n\n');
}

export interface HistoryTarget {
  turnId: string;
  llmModelId: string | null;
  providerName: string;
}

function keepsThinking(message: StoredMessage, target: HistoryTarget): boolean {
  return (
    message.turnId === target.turnId &&
    message.llmModelId !== null &&
    message.llmModelId === target.llmModelId &&
    target.providerName === 'anthropic'
  );
}

function stripThinking(blocks: LlmContentBlock[]): LlmContentBlock[] {
  return blocks.filter((block) => block.type !== 'thinking' && block.type !== 'redacted_thinking');
}

function nonEmpty(blocks: LlmContentBlock[]): LlmContentBlock[] {
  return blocks.filter((block) => !(block.type === 'text' && block.text.trim() === ''));
}

/**
 * Stored rows → wire messages, in order, repaired for the provider.
 * `exclude` is the assistant row currently being written.
 */
export function buildHistory(
  messages: StoredMessage[],
  target: HistoryTarget,
  exclude: string | null
): LlmMessage[] {
  const ordered = messages
    .filter((message) => message.id !== exclude)
    .filter((message) => message.status !== 'failed')
    .sort((a, b) => a.seq - b.seq);

  const out: LlmMessage[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const message = ordered[i];
    let blocks = nonEmpty(
      keepsThinking(message, target) ? message.blocks : stripThinking(message.blocks)
    );
    if (message.role === 'assistant') {
      // Every tool_use needs its tool_result in the very next message;
      // an interrupted turn can leave one dangling, which providers reject.
      const next = ordered[i + 1];
      const results = new Set(
        (next?.blocks ?? []).flatMap((block) =>
          block.type === 'tool_result' ? [block.toolUseId] : []
        )
      );
      blocks = blocks.filter((block) => block.type !== 'tool_use' || results.has(block.id));
    } else {
      // A tool_result whose tool_use was dropped above (or never stored)
      // is equally unwelcome.
      const previous = out[out.length - 1];
      const calls = new Set(
        (previous?.role === 'assistant' ? previous.content : []).flatMap((block) =>
          block.type === 'tool_use' ? [block.id] : []
        )
      );
      blocks = blocks.filter((block) => block.type !== 'tool_result' || calls.has(block.toolUseId));
    }
    if (blocks.length === 0) continue;
    out.push({ role: message.role, content: blocks });
  }
  // A conversation must open with the person, and the model answers a
  // person: leading assistant rows (from a deleted first prompt) go.
  while (out.length > 0 && out[0].role === 'assistant') out.shift();
  return out;
}
