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
    /** A code project: the repository the code_* tools work in, and its environment's names. */
    code?: {
      repoFullName: string;
      branch: string;
      /** The checkout is on the worker and usable; false means the tools are not offered. */
      ready: boolean;
      /** Why it is not ready, when it is not — cloning, or a clone that failed. */
      notReady: string | null;
      envNames: string[];
      /** The checkout is being cloned as this turn's first step. */
      clonedNow?: boolean;
    } | null;
  } | null;
  /** Memory carried across every chat this person owns; null inside a project. */
  userMemoryText: string | null;
  /** The chat's rolling compaction summary (compaction.ts); null until one exists. */
  chatSummary: string | null;
  chatFiles: { id: string; filename: string; contentType: string; sizeBytes: number }[];
  hasTools: boolean;
  /**
   * find_tools is among the tools (tool-discovery.ts): this chat has
   * connectors enabled beyond what is offered up front. The prompt then
   * says to search rather than ask the person for something a lookup —
   * a directory search, say — could supply on its own.
   */
  hasDiscoverableTools: boolean;
  /** search_knowledge is among the tools; the prompt then says when it is worth a call. */
  hasKnowledge: boolean;
  /**
   * outlook_search_users is among the tools: there is a live employee
   * directory, so the prompt says to use it — not search_knowledge or a
   * file — for who someone is. Optional so existing callers/fixtures that
   * predate this flag keep compiling; absent, it is simply not mentioned.
   */
  hasDirectory?: boolean;
  hasSandbox: boolean;
  /** The org has somewhere to keep files; false means none can be made or attached. */
  filesAllowed: boolean;
  now: Date;
}

const STANDING_BRIEF = `You are Renkei, an assistant inside an organization's own workspace. You answer in the person's language, plainly and specifically. When a tool would ground an answer in the organization's real data — a ticket, a document, a message, a file — use it rather than guessing; say what you looked at. Never invent identifiers, links or quotes. Format replies in Markdown: short paragraphs, lists for parallel items, fenced code for code, tables only for tabular data. Do not narrate your process or restate the question.`;

/**
 * When search_knowledge is on offer. Each search is an embedding call, a
 * database query and a live access check against the source systems, so
 * a reply that searches four times before answering is slow for the
 * person and no better informed; and a model left to its own devices
 * searches for things it already knows or was just told. Said only when
 * the tool is there, so a chat without it carries no dead advice.
 *
 * It is deliberately not framed as the default first move. search_knowledge
 * is core (always active) while a specific connector's own tool — a live
 * meeting, a current ticket, today's calendar — usually is not, so it is
 * the one thing already at hand and the easy reflex is to just use it. But
 * it searches an INDEX built by a pipeline that runs behind the source
 * systems, not the systems themselves: a meeting that started five minutes
 * ago, a ticket updated this morning, a message sent moments earlier can
 * all be real and still not have reached it yet. A live tool is both more
 * current and, once named through find_tools, no harder to call — so when
 * one plainly applies, it comes first and search_knowledge is what is
 * reached for instead when nothing more specific does, or to search
 * broadly across many sources at once.
 */
function knowledgeBrief(hasDiscoverableTools: boolean): string {
  const staleness = hasDiscoverableTools
    ? " It also runs behind the live systems it indexes — a meeting that just started, a ticket updated minutes ago or a message just sent may not be in it yet. When a specific connector's own tool (offered here, or one call away through find_tools) can answer directly from the live system, use that first; search_knowledge is for when nothing more specific applies, or for a broad look across many sources at once — not the automatic first move just because it's already active."
    : ' It also runs behind the live systems it indexes, so something that changed in the last few minutes may not be in it yet — say so if what comes back looks out of date.';
  return `search_knowledge finds what the organization has indexed from its own systems — mail, tickets, pages, documents, meetings and notes.${staleness} Use it when the answer depends on the organization's own work or records. Do not use it for general knowledge, for reasoning, or for anything this conversation already contains, and do not use it to confirm what another tool just returned. Make one well-aimed search — a specific query, k up to 10, sources when you know the kind of item — and answer from what comes back, saying what you looked at and what was not there. Search again only for a genuinely different question, not a rephrasing of the same one.`;
}

/**
 * When outlook_search_users exists for this chat — which in practice means
 * "almost always that Microsoft is connected", since `microsoft` is not a
 * core connector and the tool therefore sits in `discoverable`, not among
 * the tools offered up front (see tool-surface.ts). So this cannot just say
 * "call outlook_search_users": most of the time that name is not yet in the
 * active tool set, and the brief has to send the model through find_tools
 * first rather than assume the call will simply work.
 *
 * Without this, a question about a colleague tends to get answered from
 * whatever mentions them turn up in search_knowledge — sitting right there,
 * already active — or an attached file, instead of the one call away
 * directory that is actually authoritative. Also restates that it takes
 * several names at once, since a model that has only ever seen
 * single-lookup tools defaults to one call per person.
 */
function directoryBrief(hasKnowledge: boolean): string {
  const instead = hasKnowledge
    ? 'search_knowledge or a document, message or file'
    : 'a document, message or file';
  return `There is a live employee directory: outlook_search_users, the source of truth for who someone is — title, department, location, email, phone, manager, direct reports. For a colleague's profile or contact details, or to check who's who on a list of names, use it rather than reaching for ${instead}, which may be stale or incomplete — even though that alternative is already at hand and this is not. If outlook_search_users is not among your currently callable tools, call find_tools first (query "outlook" or "employee directory") to bring it in, then call it; do not settle for a knowledge or file search just because it avoids that extra step. It takes several names or emails in one call (pass an array) — look up an entire list of people at once instead of one call per person. Ids/UPNs it returns feed outlook_get_user for the org-chart view around someone.`;
}

/**
 * When find_tools is on offer. Its own description already names the
 * connectors it covers; this says when to reach for it, since a model that
 * only sees a handful of tools up front has no other signal that more
 * exist. Without this nudge a task needing an unoffered tool tends to get
 * answered by asking the person for information a lookup could have
 * supplied instead (an email address, a ticket key), by saying the
 * capability isn't there, or — the failure mode that is easy to miss
 * because nothing errors — by quietly reaching for search_knowledge or
 * whatever else is already active instead of the specific connector tool
 * that would actually answer the question. That third case is the common
 * one: it produces an answer, so nothing looks wrong, and the model has no
 * built-in reason to prefer a tool it would have to go find over one
 * that's sitting right there. Named explicitly so it isn't missed.
 */
const DISCOVERY_BRIEF = `This chat has connectors enabled beyond the tools listed here — schemas the model does not see until it asks for them. Before asking the person for something a tool could look up (a colleague's email or user id, an issue key, a document link), saying a capability is unavailable, or reaching for search_knowledge or another already-active tool for something a specific connector would answer more directly and currently (a live status, a person's real profile, a record as it stands now, not as it was indexed), call find_tools with a short description of what you need, or a connector name — matching tools become callable right away, for the cost of one extra call.`;

/**
 * A code project is a way of working, not just a tool family: the model
 * that treats the checkout like a careful developer would (look before
 * editing, run the project's own checks, commit small, never paste a
 * secret) does well; the one that guesses at files or asks for a token
 * does not.
 */
const CODE_BRIEF = `The code_* tools work in this repository's checkout on the sandbox. Work the way a careful developer would: read the files you will change and the project's own conventions first (code_ls, code_find, code_grep, code_read_file), make changes with code_edit_file rather than rewriting whole files, run the project's own tests, lint or build with code_run and read what they say, then commit with a clear message (code_git_commit) and push (code_git_push); a pull request is bitbucket_create_pull_request. Whether to work on a new branch is your call from what the person asks: a change meant for review goes on a branch of its own, a quick fix or an experiment they want on the current branch stays there. For a change with independent parts, or an investigation that would flood this conversation, hand a self-contained task to a sub-agent with code_delegate (its own instructions, the same tools, no pushing) and read its report critically — you own the result. Commands run with the project's environment variables (code_env_names lists the names; values are never shown): never ask for a secret's value, never put one in a command or a file, and if one is missing ask the person to add it to the project's .env. Say what you changed and what you ran.`;

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

  if (input.chatSummary) {
    sections.push(
      `Earlier in this conversation (condensed to keep it within context — the original messages are no longer sent, only this summary):\n${input.chatSummary}`
    );
  }

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
    if (input.project.code) {
      const code = input.project.code;
      project.push(
        `This is a code project on the repository ${code.repoFullName}` +
          (code.branch ? ` (branch ${code.branch})` : '') +
          (code.ready
            ? `.${code.clonedNow ? ' It is being cloned into the sandbox as this turn’s first step; that step’s result says whether the checkout is usable.' : ''}${code.envNames.length ? ` Its environment sets: ${code.envNames.join(', ')}.` : ' It has no environment variables.'}\n\n${CODE_BRIEF}`
            : `. Its checkout is not usable right now (${code.notReady ?? 'not ready'}), so the code_* tools are not available in this turn; say so if the person asks for work in the repository.`)
      );
    }
    sections.push(project.join('\n\n'));
  } else if (input.userMemoryText) {
    sections.push(
      `Memory (notes kept about this person across their chats, newest last):\n${input.userMemoryText}`
    );
  }
  if (input.chatFiles.length > 0) {
    sections.push(
      `Files attached to this chat (their text, when it could be extracted, is inline in the messages; read the rest with chat_read_attachment):\n${input.chatFiles.map(fileLine).join('\n')}`
    );
  }
  if (input.hasTools) {
    sections.push(
      input.hasSandbox
        ? "Tools act with this person's own permissions in the organization's systems. The sandbox_* tools give you a scratch space and a browser for files and pages no other tool reaches; to read a public web page or a document at a URL, sandbox_fetch_page is one call and needs no browser."
        : "Tools act with this person's own permissions in the organization's systems."
    );
  }
  if (input.hasDiscoverableTools) {
    sections.push(DISCOVERY_BRIEF);
  }
  if (input.hasDirectory) {
    sections.push(directoryBrief(input.hasKnowledge));
  }
  if (input.hasKnowledge) {
    sections.push(knowledgeBrief(input.hasDiscoverableTools));
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
    // Folded into the chat's summary (compaction.ts): the summary carries
    // this content now, sent once as system-prompt text, not per message.
    .filter((message) => message.summaryId === null)
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
    // Consecutive same-role rows (a paste chunked into several prompt rows
    // by start-turn.ts, most directly) merge into one wire message: the
    // Messages API expects turns to alternate, and two rows of one role
    // are one turn split for storage, not two turns.
    const previousOut = out[out.length - 1];
    if (previousOut && previousOut.role === message.role) {
      previousOut.content.push(...blocks);
    } else {
      out.push({ role: message.role, content: blocks });
    }
  }
  // A conversation must open with the person, and the model answers a
  // person: leading assistant rows (from a deleted first prompt) go.
  while (out.length > 0 && out[0].role === 'assistant') out.shift();
  return out;
}
