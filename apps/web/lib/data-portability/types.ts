/**
 * The shapes a person's data takes on its way out of Renkei (export) and
 * on its way in from another assistant (import). Plain data, dates as ISO
 * strings, every text already opened: the server modules (collect.ts,
 * apply-import.ts) read and write the store, and everything between —
 * the zip's files, the portable profile, the parsers — is pure and tested
 * in node.
 */

import type { LlmContentBlock } from '@renkei/agent-llm';

/** Bumped when a file in the zip changes shape, so an importer can tell. */
export const EXPORT_FORMAT_VERSION = 1;
export const EXPORT_FORMAT = 'renkei-export';

export interface ExportPerson {
  subject: string;
  displayName: string | null;
  email: string | null;
}

export interface ExportMemoryEntry {
  id: string;
  content: string;
  chatId: string | null;
  createdAt: string;
}

export interface ExportMemory {
  summary: string | null;
  /** Newest first, as the memory page lists them. */
  entries: ExportMemoryEntry[];
}

export interface ExportAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface ExportMessage {
  id: string;
  role: 'user' | 'assistant';
  kind: string;
  status: string;
  model: string | null;
  createdAt: string;
  blocks: LlmContentBlock[];
  attachments: ExportAttachment[];
}

export interface ExportChat {
  id: string;
  title: string | null;
  projectId: string | null;
  projectName: string | null;
  archived: boolean;
  temporary: boolean;
  /** The chat's key could not be opened: its messages read as markers. */
  keyUnavailable: boolean;
  createdAt: string;
  updatedAt: string;
  /** The latest compaction summary of the chat, if it has one. */
  summary: string | null;
  /** In order (by seq). */
  messages: ExportMessage[];
}

export interface ExportProject {
  id: string;
  kind: 'chat' | 'code';
  name: string;
  description: string | null;
  instructions: string | null;
  repo: { provider: string; fullName: string; branch: string } | null;
  createdAt: string;
  updatedAt: string;
  memory: ExportMemory;
}

export interface ExportData {
  exportedAt: string;
  person: ExportPerson;
  /** Every preference the person saved, by key, values as stored. */
  preferences: { key: string; value: unknown }[];
  memory: ExportMemory;
  projects: ExportProject[];
  /** Most recently touched first. */
  chats: ExportChat[];
}

/** Where an import came from, as detected from its files. */
export type ImportSource = 'chatgpt' | 'claude' | 'gemini' | 'renkei' | 'markdown';

export interface ImportedMessage {
  role: 'user' | 'assistant';
  text: string;
  createdAt: string | null;
}

export interface ImportedChat {
  title: string;
  source: ImportSource;
  createdAt: string | null;
  /** Alternating roles, none empty. */
  messages: ImportedMessage[];
}

export interface ImportPlan {
  sources: ImportSource[];
  /** Deduplicated, each within the memory entry limit. */
  memories: string[];
  chats: ImportedChat[];
  /** What was left out and why, in words for the person. */
  notes: string[];
}

/** One file of an upload, as text (a zip's members unpacked by read-upload.ts). */
export interface ImportFile {
  name: string;
  text: string;
}

/** What the import route shows before anything is written. */
export interface ImportPreview {
  /** Display names: "ChatGPT", "Claude", … */
  sources: string[];
  memories: number;
  chats: number;
  messages: number;
  /** The first few, to show what was understood. */
  sampleMemories: string[];
  sampleChats: { title: string; messages: number }[];
  notes: string[];
}

/** What an import wrote. */
export interface ImportOutcome {
  memoriesAdded: number;
  /** Left out because memory was full. */
  memoriesNoRoom: number;
  chatsAdded: number;
  messagesAdded: number;
  /** Set when the import stopped early: what could not be written. */
  stopped: 'memory-key' | 'chat-key' | null;
}
