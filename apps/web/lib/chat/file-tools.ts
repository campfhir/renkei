/**
 * chat_write_file — the model's way to hand the person a file. Every
 * other file a chat keeps came from a tool (a screenshot, a mail
 * attachment) via `_meta.renkeiDocuments`; this tool puts the model's own
 * text through the same door, so a CSV, a Markdown document or a JSON
 * export lands under the chat's Artifacts like any other, for download
 * or copying to a network share. Text-based formats only: the content is
 * the tool argument, and a binary document would have to travel as
 * base64 the model wrote — the one thing the platform's byte paths never
 * do. Offered only when the organization has a store to keep files in
 * (chat-local-tools.ts), so the model is never given a verb that can only
 * fail.
 */

import { errorResult, textResult, type LocalTool } from './local-tools';

/** More than any model writes in one call; the artifact store's own cap is far above it. */
export const WRITE_FILE_MAX_CHARS = 1_000_000;

const FILENAME_MAX = 255;

/** Extension → media type, for the formats the tool writes. */
const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  text: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  ics: 'text/calendar',
  svg: 'image/svg+xml',
  sql: 'text/plain',
  log: 'text/plain',
};

/** Media types accepted when the caller names one itself. */
const WRITABLE_MEDIA_TYPES = new Set([
  ...Object.values(MEDIA_TYPE_BY_EXTENSION),
  'application/x-yaml',
  'text/xml',
  'text/x-markdown',
]);

/** Formats people ask for that this tool cannot produce, with what to do instead. */
const BINARY_EXTENSIONS: Record<string, string> = {
  xlsx: 'write the data as CSV (.csv) instead — it opens in Excel',
  xls: 'write the data as CSV (.csv) instead — it opens in Excel',
  docx: 'write the document as Markdown (.md) or plain text (.txt) instead',
  doc: 'write the document as Markdown (.md) or plain text (.txt) instead',
  pptx: 'write the outline as Markdown (.md) instead',
  pdf: 'write the document as Markdown (.md) or plain text (.txt) instead',
  zip: 'write the files one at a time instead',
  png: 'only text-based files can be written',
  jpg: 'only text-based files can be written',
  jpeg: 'only text-based files can be written',
  gif: 'only text-based files can be written',
};

export const WRITABLE_EXTENSIONS: readonly string[] = Object.keys(MEDIA_TYPE_BY_EXTENSION);

export type FilenameCheck = { ok: true; filename: string } | { ok: false; reason: string };

/** A display name for a file: one path segment, printable, bounded. */
export function checkFilename(raw: unknown): FilenameCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'filename must be a string.' };
  const filename = raw.trim();
  if (!filename) return { ok: false, reason: 'filename must not be empty.' };
  if (filename.length > FILENAME_MAX) {
    return { ok: false, reason: `filename must be at most ${FILENAME_MAX} characters.` };
  }
  if (filename === '.' || filename === '..') return { ok: false, reason: 'filename is not a name.' };
  if (/[/\\]/.test(filename)) {
    return { ok: false, reason: 'filename must be a name, not a path.' };
  }
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\x00-\x1f\x7f]/.test(filename)) {
    return { ok: false, reason: 'filename must not contain control characters.' };
  }
  return { ok: true, filename };
}

export function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
}

export type MediaTypeCheck = { ok: true; mediaType: string } | { ok: false; reason: string };

/**
 * The media type a file is written as: the caller's, when it names one the
 * tool can write; else the one its extension implies; else plain text.
 * A binary extension is refused with the text format to use instead.
 */
export function resolveMediaType(filename: string, requested: unknown): MediaTypeCheck {
  const extension = extensionOf(filename);
  if (extension && BINARY_EXTENSIONS[extension]) {
    return {
      ok: false,
      reason: `.${extension} files cannot be written here: ${BINARY_EXTENSIONS[extension]}.`,
    };
  }
  if (typeof requested === 'string' && requested.trim()) {
    const mediaType = requested.trim().toLowerCase().split(';')[0]!.trim();
    if (!WRITABLE_MEDIA_TYPES.has(mediaType) && !mediaType.startsWith('text/')) {
      return {
        ok: false,
        reason: `${mediaType} is not a text format this tool writes; use one of: ${[...WRITABLE_MEDIA_TYPES].sort().join(', ')}.`,
      };
    }
    return { ok: true, mediaType };
  }
  return { ok: true, mediaType: (extension && MEDIA_TYPE_BY_EXTENSION[extension]) || 'text/plain' };
}

export function fileTools(): LocalTool[] {
  return [
    {
      def: {
        name: 'chat_write_file',
        description:
          'Write a text-based file for the person to keep — a CSV export, a Markdown or plain-text document, JSON, HTML, XML, YAML. ' +
          'The file appears under this chat’s Artifacts, where they can download it or copy it to a connected network share. ' +
          'Pass the full content as text (never base64). Only text formats can be written: for a spreadsheet write CSV, for a document write Markdown. ' +
          'Each call writes one file; write again with the same name to hand over a corrected version.',
        inputSchema: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description:
                'The name to save as, with an extension (report.csv, notes.md, export.json). A name, not a path.',
            },
            content: {
              type: 'string',
              description: `The complete file content, as text (at most ${WRITE_FILE_MAX_CHARS} characters).`,
            },
            contentType: {
              type: 'string',
              description:
                'Media type, when the extension does not say (default: implied by the extension, else text/plain).',
            },
          },
          required: ['filename', 'content'],
        },
      },
      async execute(input) {
        const name = checkFilename(input.filename);
        if (!name.ok) return errorResult(name.reason);
        if (typeof input.content !== 'string') {
          return errorResult('content must be a string — the whole file, as text.');
        }
        if (input.content.length > WRITE_FILE_MAX_CHARS) {
          return errorResult(
            `content is ${input.content.length} characters; at most ${WRITE_FILE_MAX_CHARS} can be written in one file.`
          );
        }
        const type = resolveMediaType(name.filename, input.contentType);
        if (!type.ok) return errorResult(type.reason);
        const bytes = Buffer.from(input.content, 'utf8');
        return textResult(
          `Wrote ${name.filename} (${type.mediaType}, ${bytes.byteLength} bytes). It is under this chat’s Artifacts, where the person can download it or copy it to a network share; tell them so, and do not repeat the content.`,
          {
            renkeiDocuments: [
              {
                mediaType: type.mediaType,
                dataBase64: bytes.toString('base64'),
                title: name.filename,
              },
            ],
          }
        );
      },
    },
  ];
}
