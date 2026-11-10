/**
 * Reading another assistant's export into one plan: the memories to add
 * and the chats to recreate. Pure — files in as text (read-upload.ts
 * unpacks a zip), a plan out — so every format is tested in node, and
 * the route shows the plan as a preview before anything is written.
 *
 * What is recognised, by the file's shape rather than its name (people
 * rename files):
 *
 *   - ChatGPT's data export: `conversations.json`, an array of
 *     conversations whose messages are a tree (`mapping`) walked from
 *     `current_node` back to the root — the branch the person last saw.
 *   - Claude's data export: `conversations.json`, an array with
 *     `chat_messages` (sender `human`/`assistant`), and `memories.json`
 *     (`conversations_memory` and `project_memories`, prose).
 *   - Gemini, through Google Takeout: `MyActivity.json`, one item per
 *     prompt ("Prompted …") with the reply as HTML. Takeout keeps no
 *     conversations, so each day's prompts become one chat.
 *   - Renkei's own export zip (export-bundle.ts): `memory.json` and
 *     `chats/*.json`.
 *   - Markdown or plain text: a list of things about the person — what
 *     ChatGPT's or Gemini's "what do you know about me" answers, or a
 *     profile.md from here (only its memory section is read).
 *
 * Memories are split to the memory entry limit and deduplicated; chats
 * keep alternating roles (consecutive messages of one role are joined)
 * and are capped, the newest kept. What is left out is said in `notes`.
 */

import { isRecord, isString } from '@renkei/guards';
import { PROFILE_MEMORY_HEADING } from './profile-markdown';
import type {
  ImportFile,
  ImportPlan,
  ImportPreview,
  ImportSource,
  ImportedChat,
  ImportedMessage,
} from './types';

/** user-memory.ts's USER_MEMORY_ENTRY_MAX_CHARS and USER_MEMORY_HARD_CAP (kept equal by app/api/account/import/route.test.ts). */
export const IMPORT_MEMORY_MAX_CHARS = 500;
export const IMPORT_MAX_MEMORIES = 300;
export const IMPORT_MAX_CHATS = 500;
export const IMPORT_MAX_MESSAGES_PER_CHAT = 1_000;
export const IMPORT_MAX_MESSAGE_CHARS = 100_000;
const TITLE_MAX_CHARS = 120;

const SOURCE_NAMES: Record<ImportSource, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  renkei: 'Renkei',
  markdown: 'Markdown',
};

export function sourceName(source: ImportSource): string {
  return SOURCE_NAMES[source];
}

// ── Text helpers ────────────────────────────────────────────────────────

/** Unix seconds (ChatGPT) or an ISO string, as ISO; null when neither. */
function isoOf(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  if (isString(value)) {
    const time = Date.parse(value);
    return Number.isNaN(time) ? null : new Date(time).toISOString();
  }
  return null;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Tags that end a line of text: a block closing, or a line break. */
const LINE_ENDING_TAGS = new Set([
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'pre',
  'blockquote',
  'tr',
]);

/** One HTML entity as its character, or the entity as written when unknown. */
function decodeEntity(whole: string, code: string): string {
  if (code.startsWith('#x') || code.startsWith('#X')) {
    const point = parseInt(code.slice(2), 16);
    return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  }
  if (code.startsWith('#')) {
    const point = parseInt(code.slice(1), 10);
    return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
  }
  return ENTITIES[code.toLowerCase()] ?? whole;
}

/**
 * HTML (a Takeout reply) as plain text: paragraphs and list items on lines
 * of their own. One pass over the characters rather than a chain of tag
 * regexes: every tag is dropped wherever it starts, the contents of
 * <script> and <style> go with them, and entities are decoded once, last,
 * so a decoded `<` stays text. The result is only ever stored and shown as
 * text (a chat message), never as markup.
 */
export function htmlToText(html: string): string {
  let text = '';
  let skipping: string | null = null;
  let at = 0;
  while (at < html.length) {
    const open = html.indexOf('<', at);
    if (open < 0) {
      if (!skipping) text += html.slice(at);
      break;
    }
    if (!skipping) text += html.slice(at, open);
    const close = html.indexOf('>', open + 1);
    if (close < 0) break;
    const inner = html
      .slice(open + 1, close)
      .trim()
      .toLowerCase();
    const closing = inner.startsWith('/');
    const name = (closing ? inner.slice(1) : inner).split(/[\s/]/, 1)[0];
    at = close + 1;
    if (skipping) {
      if (closing && name === skipping) skipping = null;
      continue;
    }
    if (!closing && (name === 'script' || name === 'style')) skipping = name;
    else if (name === 'br') text += '\n';
    else if (name === 'li' && !closing) text += '\n- ';
    else if (closing && LINE_ENDING_TAGS.has(name)) text += '\n';
  }
  return text
    .replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, decodeEntity)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Text split after each run of sentence-ending punctuation (and any closing quote or bracket). */
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let at = 0;
  while (at < text.length) {
    if ('.!?'.includes(text[at])) {
      let end = at + 1;
      while (end < text.length && '.!?"\')]'.includes(text[end])) end += 1;
      out.push(text.slice(start, end));
      start = end;
      at = end;
    } else {
      at += 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** Text cut into pieces of at most `max` characters, at sentence ends where it can. */
export function chunkText(text: string, max: number): string[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat ? [flat] : [];
  const pieces: string[] = [];
  let current = '';
  for (const raw of sentencesOf(flat)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length > max) {
      if (current) pieces.push(current);
      current = '';
      for (let at = 0; at < sentence.length; at += max) pieces.push(sentence.slice(at, at + max));
      continue;
    }
    if (current && current.length + 1 + sentence.length > max) {
      pieces.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

const BULLET = /^\s*(?:[-*•+]|\d+[.)])\s+(.*)$/;
const DATE_PREFIX = /^\[?\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?\]?\s*[:–—-]?\s*/;
/** A line that only names a section: `# Work`, `**Work context**`, `Work:`. */
const SECTION_LINE = /^(?:#{1,6}\s+.*|\*\*[^*]+\*\*:?|__[^_]+__:?|[^.!?]{1,40}:)$/;

function cleanItem(text: string): string {
  return text.replace(DATE_PREFIX, '').replace(/\s+/g, ' ').trim();
}

/**
 * Things about a person, from Markdown or plain text: each list item is
 * one; without a list, each paragraph is (or each line, when the text is
 * one block of short lines). Headings and lines that only name a section
 * are left out; long items are split to `max`.
 */
export function memoriesFromText(text: string, max = IMPORT_MEMORY_MAX_CHARS): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const section = profileMemorySection(normalized) ?? normalized;
  const lines = section.split('\n');
  const bullets = lines
    .map((line) => BULLET.exec(line)?.[1])
    .filter((item): item is string => item !== undefined)
    .map(cleanItem)
    .filter(Boolean);
  let items: string[];
  if (bullets.length > 0) {
    items = bullets;
  } else {
    const paragraphs = section
      .split(/\n\s*\n/)
      .map((block) =>
        block
          .split('\n')
          .filter((line) => !SECTION_LINE.test(line.trim()))
          .join('\n')
          .trim()
      )
      .filter(Boolean);
    const oneBlockOfLines =
      paragraphs.length === 1 &&
      paragraphs[0].split('\n').length > 1 &&
      paragraphs[0].split('\n').every((line) => line.trim().length <= 200);
    items = (oneBlockOfLines ? paragraphs[0].split('\n') : paragraphs).map(cleanItem);
  }
  return items
    .filter((item) => item && !/^_.*_$/.test(item))
    .flatMap((item) => chunkText(item, max));
}

/** A profile.md's memory section (between its heading and the next `## `), or null when it has none. */
function profileMemorySection(text: string): string | null {
  const start = text.indexOf(`## ${PROFILE_MEMORY_HEADING}`);
  if (start < 0) return null;
  const body = text.slice(start + PROFILE_MEMORY_HEADING.length + 3);
  const end = body.search(/\n## /);
  return end < 0 ? body : body.slice(0, end);
}

// ── Chats ───────────────────────────────────────────────────────────────

/** Alternating roles, no empty messages, each within the length limit, at most the per-chat cap. */
export function normalizeMessages(messages: ImportedMessage[]): {
  messages: ImportedMessage[];
  clipped: boolean;
} {
  const out: ImportedMessage[] = [];
  for (const message of messages) {
    const text = message.text.trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === message.role) {
      last.text = `${last.text}\n\n${text}`;
    } else {
      out.push({ role: message.role, text, createdAt: message.createdAt });
    }
  }
  let clipped = out.length > IMPORT_MAX_MESSAGES_PER_CHAT;
  const kept = out.slice(0, IMPORT_MAX_MESSAGES_PER_CHAT).map((message) => {
    if (message.text.length <= IMPORT_MAX_MESSAGE_CHARS) return message;
    clipped = true;
    return { ...message, text: `${message.text.slice(0, IMPORT_MAX_MESSAGE_CHARS - 1)}…` };
  });
  return { messages: kept, clipped };
}

function titleOf(title: unknown, messages: ImportedMessage[]): string {
  const given = isString(title) ? title.replace(/\s+/g, ' ').trim() : '';
  const fallback = messages.find((message) => message.role === 'user')?.text ?? 'Imported chat';
  const text = given || fallback.replace(/\s+/g, ' ').trim();
  return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS - 1)}…` : text;
}

interface ChatDraft {
  title: unknown;
  createdAt: string | null;
  messages: ImportedMessage[];
}

// ChatGPT ─────────────

function isChatGptConversations(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.some((item) => isRecord(item) && isRecord(item.mapping));
}

function chatGptMessage(node: unknown): ImportedMessage | null {
  if (!isRecord(node) || !isRecord(node.message)) return null;
  const message = node.message;
  const author = isRecord(message.author) ? message.author.role : null;
  if (author !== 'user' && author !== 'assistant') return null;
  const metadata = isRecord(message.metadata) ? message.metadata : {};
  if (metadata.is_visually_hidden_from_conversation === true) return null;
  const content = isRecord(message.content) ? message.content : {};
  const type = content.content_type;
  if (type !== undefined && type !== 'text' && type !== 'multimodal_text') return null;
  const parts = Array.isArray(content.parts) ? content.parts.filter(isString) : [];
  const text = parts.join('\n').trim();
  if (!text) return null;
  return { role: author, text, createdAt: isoOf(message.create_time) };
}

function chatGptChats(conversations: unknown[]): ChatDraft[] {
  return conversations.filter(isRecord).map((conversation) => {
    const mapping = isRecord(conversation.mapping) ? conversation.mapping : {};
    const ordered: unknown[] = [];
    const seen = new Set<string>();
    let at = isString(conversation.current_node) ? conversation.current_node : null;
    while (at && !seen.has(at) && isRecord(mapping[at])) {
      seen.add(at);
      const node = mapping[at];
      ordered.push(node);
      at = isRecord(node) && isString(node.parent) ? node.parent : null;
    }
    // No current node (an older export): every node, by time.
    const nodes =
      ordered.length > 0
        ? ordered.reverse()
        : Object.values(mapping).sort((a, b) => {
            const time = (node: unknown) =>
              isRecord(node) &&
              isRecord(node.message) &&
              typeof node.message.create_time === 'number'
                ? node.message.create_time
                : 0;
            return time(a) - time(b);
          });
    return {
      title: conversation.title,
      createdAt: isoOf(conversation.create_time),
      messages: nodes
        .map(chatGptMessage)
        .filter((message): message is ImportedMessage => message !== null),
    };
  });
}

// Claude ──────────────

function isClaudeConversations(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.some((item) => isRecord(item) && Array.isArray(item.chat_messages))
  );
}

function claudeText(message: Record<string, unknown>): string {
  if (Array.isArray(message.content)) {
    const text = message.content
      .filter((block) => isRecord(block) && block.type === 'text' && isString(block.text))
      .map((block) => (isRecord(block) && isString(block.text) ? block.text : ''))
      .join('\n\n')
      .trim();
    if (text) return text;
  }
  return isString(message.text) ? message.text : '';
}

function claudeChats(conversations: unknown[]): ChatDraft[] {
  return conversations.filter(isRecord).map((conversation) => ({
    title: conversation.name,
    createdAt: isoOf(conversation.created_at),
    messages: (Array.isArray(conversation.chat_messages) ? conversation.chat_messages : [])
      .filter(isRecord)
      .flatMap((message): ImportedMessage[] => {
        const role =
          message.sender === 'human' ? 'user' : message.sender === 'assistant' ? 'assistant' : null;
        if (!role) return [];
        return [{ role, text: claudeText(message), createdAt: isoOf(message.created_at) }];
      }),
  }));
}

function isClaudeMemories(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.some(
      (item) =>
        isRecord(item) && (isString(item.conversations_memory) || isRecord(item.project_memories))
    )
  );
}

function claudeMemories(items: unknown[]): string[] {
  return items.filter(isRecord).flatMap((item) => [
    ...(isString(item.conversations_memory) ? memoriesFromText(item.conversations_memory) : []),
    ...(isRecord(item.project_memories)
      ? Object.values(item.project_memories)
          .filter(isString)
          .flatMap((text) => memoriesFromText(text))
      : []),
  ]);
}

// Gemini (Takeout) ────

const GEMINI_HEADERS = new Set(['Gemini Apps', 'Gemini', 'Bard']);

function isGeminiActivity(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.some(
      (item) =>
        isRecord(item) &&
        isString(item.title) &&
        (GEMINI_HEADERS.has(String(item.header)) ||
          (Array.isArray(item.products) &&
            item.products.some((p) => GEMINI_HEADERS.has(String(p)))))
    )
  );
}

function geminiChats(items: unknown[]): ChatDraft[] {
  const byDay = new Map<string, { time: string; messages: ImportedMessage[] }[]>();
  for (const item of items) {
    if (!isRecord(item) || !isString(item.title) || !item.title.startsWith('Prompted ')) continue;
    const time = isoOf(item.time);
    if (!time) continue;
    const reply = (Array.isArray(item.safeHtmlItem) ? item.safeHtmlItem : [])
      .map((part) => (isRecord(part) && isString(part.html) ? htmlToText(part.html) : ''))
      .filter(Boolean)
      .join('\n\n');
    const exchange: ImportedMessage[] = [
      { role: 'user', text: item.title.slice('Prompted '.length), createdAt: time },
    ];
    if (reply) exchange.push({ role: 'assistant', text: reply, createdAt: time });
    const day = time.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), { time, messages: exchange }]);
  }
  return [...byDay.entries()].map(([day, exchanges]) => {
    // Takeout lists newest first; a chat reads oldest first.
    const ordered = exchanges.sort((a, b) => a.time.localeCompare(b.time));
    return {
      title: `Gemini, ${day}`,
      createdAt: ordered[0].time,
      messages: ordered.flatMap((exchange) => exchange.messages),
    };
  });
}

// Renkei ──────────────

function isRenkeiMemory(name: string, value: unknown): value is Record<string, unknown> {
  return /(^|\/)memory\.json$/.test(name) && isRecord(value) && Array.isArray(value.entries);
}

function renkeiMemories(memory: Record<string, unknown>): string[] {
  const entries = Array.isArray(memory.entries) ? memory.entries : [];
  // Newest first in the file; added oldest first, so the newest stays newest.
  return entries
    .filter(isRecord)
    .map((entry) => (isString(entry.content) ? entry.content : ''))
    .reverse()
    .flatMap((content) => chunkText(content, IMPORT_MEMORY_MAX_CHARS));
}

function isRenkeiChat(name: string, value: unknown): value is Record<string, unknown> {
  return (
    /(^|\/)chats\/[^/]+\.json$/.test(name) &&
    !name.endsWith('index.json') &&
    isRecord(value) &&
    Array.isArray(value.messages)
  );
}

function renkeiChat(chat: Record<string, unknown>): ChatDraft {
  const messages = (Array.isArray(chat.messages) ? chat.messages : [])
    .filter(isRecord)
    .flatMap((message): ImportedMessage[] => {
      if (message.kind !== 'prompt' && message.kind !== 'assistant') return [];
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const text = (Array.isArray(message.blocks) ? message.blocks : [])
        .map((block) =>
          isRecord(block) && block.type === 'text' && isString(block.text) ? block.text : ''
        )
        .filter(Boolean)
        .join('\n\n');
      return [{ role, text, createdAt: isoOf(message.createdAt) }];
    });
  return { title: chat.title, createdAt: isoOf(chat.createdAt), messages };
}

// ── The plan ────────────────────────────────────────────────────────────

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const TEXT_FILE = /\.(md|markdown|txt)$/i;

export function parseImportFiles(files: ImportFile[]): ImportPlan {
  const sources = new Set<ImportSource>();
  const memories: string[] = [];
  const drafts: { source: ImportSource; draft: ChatDraft }[] = [];
  const notes: string[] = [];
  const unread: string[] = [];

  for (const file of files) {
    const name = file.name.replace(/\\/g, '/');
    if (TEXT_FILE.test(name) || !name.toLowerCase().endsWith('.json')) {
      // A Renkei zip's own Markdown repeats its JSON; read only the JSON.
      if (files.some((other) => /(^|\/)manifest\.json$/.test(other.name))) continue;
      const found = memoriesFromText(file.text);
      if (found.length > 0) {
        sources.add('markdown');
        memories.push(...found);
      } else {
        unread.push(name);
      }
      continue;
    }
    const parsed = parseJson(file.text);
    if (!parsed.ok) {
      unread.push(name);
      continue;
    }
    const value = parsed.value;
    if (isChatGptConversations(value)) {
      sources.add('chatgpt');
      drafts.push(...chatGptChats(value).map((draft) => ({ source: 'chatgpt' as const, draft })));
    } else if (isClaudeConversations(value)) {
      sources.add('claude');
      drafts.push(...claudeChats(value).map((draft) => ({ source: 'claude' as const, draft })));
    } else if (isClaudeMemories(value)) {
      sources.add('claude');
      memories.push(...claudeMemories(value));
    } else if (isGeminiActivity(value)) {
      sources.add('gemini');
      drafts.push(...geminiChats(value).map((draft) => ({ source: 'gemini' as const, draft })));
    } else if (isRenkeiMemory(name, value)) {
      sources.add('renkei');
      memories.push(...renkeiMemories(value));
    } else if (isRenkeiChat(name, value)) {
      sources.add('renkei');
      drafts.push({ source: 'renkei', draft: renkeiChat(value) });
    } else {
      unread.push(name);
    }
  }

  const seen = new Set<string>();
  const unique = memories.filter((memory) => {
    const key = memory.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length > IMPORT_MAX_MEMORIES) {
    notes.push(
      `${unique.length - IMPORT_MAX_MEMORIES} memories left out: memory holds at most ${IMPORT_MAX_MEMORIES}.`
    );
  }

  let clippedChats = 0;
  const chats: ImportedChat[] = drafts.flatMap(({ source, draft }) => {
    const { messages, clipped } = normalizeMessages(draft.messages);
    if (!messages.some((message) => message.role === 'user')) return [];
    if (clipped) clippedChats += 1;
    return [
      {
        title: titleOf(draft.title, messages),
        source,
        createdAt: draft.createdAt ?? messages[0].createdAt,
        messages,
      },
    ];
  });
  // The newest are kept; they are written oldest first, so the newest lands on top.
  chats.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  if (chats.length > IMPORT_MAX_CHATS) {
    notes.push(
      `${chats.length - IMPORT_MAX_CHATS} older chats left out: one import brings at most ${IMPORT_MAX_CHATS}.`
    );
  }
  const kept = chats.slice(0, IMPORT_MAX_CHATS).reverse();
  if (clippedChats > 0) {
    notes.push(
      `${clippedChats} chat${clippedChats === 1 ? ' was' : 's were'} shortened to fit (very long messages or more than ${IMPORT_MAX_MESSAGES_PER_CHAT} messages).`
    );
  }
  // An export carries side files (ChatGPT's feedback and shares, say); they
  // are worth naming only when nothing else in the upload was read.
  if (unread.length > 0 && sources.size === 0) {
    const shown = unread.slice(0, 3).join(', ');
    notes.push(
      `Not recognised, left out: ${shown}${unread.length > 3 ? ` and ${unread.length - 3} more` : ''}.`
    );
  }

  return {
    sources: [...sources],
    memories: unique.slice(0, IMPORT_MAX_MEMORIES),
    chats: kept,
    notes,
  };
}

const SAMPLE_SIZE = 5;

/** The plan as the preview shows it: counts, a few examples, and the notes. */
export function previewOf(plan: ImportPlan): ImportPreview {
  return {
    sources: plan.sources.map(sourceName),
    memories: plan.memories.length,
    chats: plan.chats.length,
    messages: plan.chats.reduce((sum, chat) => sum + chat.messages.length, 0),
    sampleMemories: plan.memories.slice(0, SAMPLE_SIZE),
    // The newest first: the plan holds them oldest first, for writing.
    sampleChats: plan.chats
      .slice(-SAMPLE_SIZE)
      .reverse()
      .map((chat) => ({ title: chat.title, messages: chat.messages.length })),
    notes: plan.notes,
  };
}
