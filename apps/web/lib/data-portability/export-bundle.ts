/**
 * What goes in a person's data export zip, file by file: the machine-
 * readable JSON (what an importer — Renkei's own, import-parse.ts, or
 * anyone's — reads), a readable Markdown transcript beside each chat, the
 * portable profile, and a README saying what each file is. The zip itself
 * is made by the route; this decides only names and contents.
 *
 *   README.md            what is here
 *   manifest.json        format, version, when, counts
 *   account.json         who the export is for
 *   preferences.json     every saved preference, as stored
 *   memory.json          the memory summary and entries
 *   memory.md            the same, to read
 *   projects.json        owned projects, instructions and project memory
 *   profile.md           the portable profile (profile-markdown.ts)
 *   chats/index.json     one line per chat, pointing at its files
 *   chats/<stem>.json    a chat and its messages, every block as stored
 *   chats/<stem>.md      the same chat as a transcript
 */

import { renderProfileMarkdown } from './profile-markdown';
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  type ExportChat,
  type ExportData,
  type ExportMemory,
  type ExportMessage,
} from './types';

export interface ExportFile {
  path: string;
  content: string;
}

/** A name safe in any file system: lower-case words joined by dashes, at most 48 characters. */
export function slugOf(text: string | null): string {
  const words =
    (text ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  let slug = words.join('-').slice(0, 48);
  while (slug.endsWith('-')) slug = slug.slice(0, -1);
  return slug || 'untitled';
}

/** `2026-03-04-plan-the-offsite-1a2b3c4d`: sorts by day, unique by id. */
export function chatFileStem(chat: Pick<ExportChat, 'id' | 'title' | 'createdAt'>): string {
  return `${chat.createdAt.slice(0, 10)}-${slugOf(chat.title)}-${chat.id.slice(0, 8)}`;
}

/** The zip's own name: `renkei-export-2026-11-06.zip`. */
export function exportFileName(exportedAt: string): string {
  return `renkei-export-${exportedAt.slice(0, 10)}.zip`;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function messageMarkdown(message: ExportMessage): string | null {
  const parts: string[] = [];
  for (const block of message.blocks) {
    if (block.type === 'text' && block.text.trim()) parts.push(block.text.trim());
    if (block.type === 'tool_use') parts.push(`_Used the tool \`${block.name}\`._`);
  }
  for (const file of message.attachments) parts.push(`_Attached ${file.filename}._`);
  if (parts.length === 0) return null;
  const who =
    message.role === 'user' ? 'You' : `Assistant${message.model ? ` (${message.model})` : ''}`;
  return `**${who}** · ${message.createdAt.slice(0, 16).replace('T', ' ')}\n\n${parts.join('\n\n')}`;
}

/** A chat as a transcript to read: the person's words and the replies; tool results and thinking stay in the JSON. */
export function chatTranscriptMarkdown(chat: ExportChat): string {
  const head = [`# ${chat.title ?? 'Untitled chat'}`];
  const facts = [`Started ${chat.createdAt.slice(0, 10)}`];
  if (chat.projectName) facts.push(`in ${chat.projectName}`);
  if (chat.archived) facts.push('archived');
  if (chat.temporary) facts.push('temporary');
  head.push(facts.join(' · '));
  if (chat.keyUnavailable) {
    head.push(
      '> This chat is sealed under a key this session could not open; its text is not included.'
    );
  }
  if (chat.summary) head.push(`> Summary: ${chat.summary.replace(/\n+/g, ' ')}`);
  const body = chat.messages
    .filter((message) => message.kind !== 'tool_results')
    .map(messageMarkdown)
    .filter((part): part is string => part !== null);
  return `${[...head, ...body].join('\n\n')}\n`;
}

export function memoryMarkdown(memory: ExportMemory): string {
  const lines = ['# Memory'];
  if (memory.summary) lines.push('## Summary', memory.summary.trim());
  lines.push('## Entries');
  if (memory.entries.length === 0) lines.push('_None._');
  for (const entry of [...memory.entries].reverse()) {
    lines.push(`- ${entry.createdAt.slice(0, 10)}: ${entry.content}`);
  }
  return `${lines.join('\n\n')}\n`;
}

function readme(data: ExportData): string {
  return `# Your Renkei data

Exported ${data.exportedAt} for ${data.person.displayName ?? data.person.email ?? data.person.subject}.

- \`profile.md\` — a summary of you to give another assistant (ChatGPT, Claude, Gemini): paste it
  into a chat or upload it as a file.
- \`memory.json\`, \`memory.md\` — what your assistant remembers about you.
- \`preferences.json\` — every preference you have saved.
- \`projects.json\` — the projects you own, their instructions and their memory.
- \`chats/\` — every chat you own: \`<name>.json\` with every message as stored, \`<name>.md\` to read.
  \`chats/index.json\` lists them.
- \`account.json\`, \`manifest.json\` — who this export is for, and what is in it.

Files you attached to chats are listed with their messages but not included.
This zip can be imported into Renkei again from Preferences → Your data.
`;
}

export function exportFiles(data: ExportData): ExportFile[] {
  const stems = data.chats.map(chatFileStem);
  const messageCount = data.chats.reduce((sum, chat) => sum + chat.messages.length, 0);
  return [
    { path: 'README.md', content: readme(data) },
    {
      path: 'manifest.json',
      content: json({
        format: EXPORT_FORMAT,
        version: EXPORT_FORMAT_VERSION,
        exportedAt: data.exportedAt,
        counts: {
          chats: data.chats.length,
          messages: messageCount,
          memoryEntries: data.memory.entries.length,
          projects: data.projects.length,
          preferences: data.preferences.length,
        },
      }),
    },
    { path: 'account.json', content: json(data.person) },
    {
      path: 'preferences.json',
      content: json(Object.fromEntries(data.preferences.map((pref) => [pref.key, pref.value]))),
    },
    { path: 'memory.json', content: json(data.memory) },
    { path: 'memory.md', content: memoryMarkdown(data.memory) },
    { path: 'projects.json', content: json(data.projects) },
    { path: 'profile.md', content: renderProfileMarkdown(data) },
    {
      path: 'chats/index.json',
      content: json(
        data.chats.map((chat, index) => ({
          id: chat.id,
          title: chat.title,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          projectName: chat.projectName,
          archived: chat.archived,
          temporary: chat.temporary,
          messages: chat.messages.length,
          json: `chats/${stems[index]}.json`,
          markdown: `chats/${stems[index]}.md`,
        }))
      ),
    },
    ...data.chats.flatMap((chat, index) => [
      { path: `chats/${stems[index]}.json`, content: json(chat) },
      { path: `chats/${stems[index]}.md`, content: chatTranscriptMarkdown(chat) },
    ]),
  ];
}
