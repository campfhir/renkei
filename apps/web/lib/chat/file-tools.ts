/**
 * chat_write_file — the model's way to hand the person a file. Every
 * other file a chat keeps came from a tool (a screenshot, a mail
 * attachment) via `_meta.renkeiDocuments`; this tool puts the model's own
 * writing through the same door, so it lands under the chat's Artifacts
 * like any other, for download or copying to a network share.
 *
 * For documents the model writes text. A text format (CSV, Markdown, JSON,
 * …) is kept as written; a document format (.docx, .pdf, .pptx, .xlsx)
 * is RENDERED here from that text — Markdown for the three documents,
 * CSV / JSON / Markdown tables for the workbook — by a library that
 * produces a valid file deterministically (@renkei/document-render, also
 * used by sandbox_render_document for org agents), so the model's cost is
 * the same whether the result is a .csv or an .xlsx.
 *
 * The one exception to "text only" is chat_write_binary_file: a PNG, JPEG,
 * TIFF or PDF the model writes as base64. Those bytes are never kept as
 * given — each format's validator in @renkei/document-render parses them
 * and, for images, REBUILDS the file from the parsed pixels (metadata,
 * trailing data and polyglot payloads do not survive), while a PDF is
 * refused if it carries anything that can act (scripts, launch actions,
 * attachments, forms). Nothing is executed or rendered to check them.
 * Offered only when the organization has a store to keep files in
 * (chat-local-tools.ts), so the model is never given a verb that can
 * only fail.
 */

import {
  BINARY_EXTENSIONS,
  BINARY_MAX_BASE64_CHARS,
  BINARY_MAX_BYTES,
  extensionOf,
  isBinaryExtension,
  isRenderedExtension,
  renderDocument,
  RENDER_INPUT_MAX_CHARS,
  resolveMediaType,
  sanitizeBinary,
  WRITABLE_EXTENSIONS,
} from '@renkei/document-render';
import { errorResult, textResult, type LocalTool } from './local-tools';

/** More than any model writes in one call; the artifact store's own cap is far above it. */
export const WRITE_FILE_MAX_CHARS = RENDER_INPUT_MAX_CHARS;

const FILENAME_MAX = 255;

export { extensionOf, resolveMediaType, WRITABLE_EXTENSIONS };
export type { MediaTypeCheck } from '@renkei/document-render';

export type FilenameCheck = { ok: true; filename: string } | { ok: false; reason: string };

/** A display name for a file: one path segment, printable, bounded. */
export function checkFilename(raw: unknown): FilenameCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'filename must be a string.' };
  const filename = raw.trim();
  if (!filename) return { ok: false, reason: 'filename must not be empty.' };
  if (filename.length > FILENAME_MAX) {
    return { ok: false, reason: `filename must be at most ${FILENAME_MAX} characters.` };
  }
  if (filename === '.' || filename === '..')
    return { ok: false, reason: 'filename is not a name.' };
  if (/[/\\]/.test(filename)) {
    return { ok: false, reason: 'filename must be a name, not a path.' };
  }
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\x00-\x1f\x7f]/.test(filename)) {
    return { ok: false, reason: 'filename must not contain control characters.' };
  }
  return { ok: true, filename };
}

const KEPT_LINE =
  'It is under this chat’s Artifacts, where the person can download it or copy it to a network share; tell them so, and do not repeat the content.';

export function fileTools(): LocalTool[] {
  return [
    {
      def: {
        name: 'chat_write_file',
        description:
          'Write a file for the person to keep. It appears under this chat’s Artifacts, where they can download it or copy it to a connected network share. ' +
          'Pass the whole content as text, never base64; the extension decides what is made. ' +
          'Text formats (.csv, .tsv, .md, .txt, .json, .html, .xml, .yaml) are kept exactly as written. ' +
          'Document formats are rendered from your text: .docx (Word) and .pdf from Markdown — headings, paragraphs, bullet and numbered lists, tables, code blocks, quotes; ' +
          '.pptx (PowerPoint) from Markdown where every # or ## heading starts a slide and what follows is its body; ' +
          '.xlsx (Excel) from CSV, or JSON {"sheets":[{"name":…,"rows":[[…],…]}]} for several sheets, or Markdown tables (one sheet each, named by the heading above). ' +
          'Numbers and dates in a workbook are typed as such. Each call writes one file; write again with the same name to hand over a corrected version.',
        inputSchema: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description:
                'The name to save as, with an extension (report.xlsx, brief.docx, deck.pptx, summary.pdf, data.csv, notes.md). A name, not a path.',
            },
            content: {
              type: 'string',
              description: `The complete content, as text (at most ${WRITE_FILE_MAX_CHARS} characters): Markdown for .docx/.pdf/.pptx, CSV or JSON or Markdown tables for .xlsx, the file itself for a text format.`,
            },
            contentType: {
              type: 'string',
              description:
                'For text formats only: the media type, when the extension does not say (default: implied by the extension, else text/plain).',
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
        const extension = extensionOf(name.filename);
        if (extension && isRenderedExtension(extension)) {
          const rendered = await renderDocument(extension, name.filename, input.content);
          const notes = rendered.notes.length ? `\n\nNote: ${rendered.notes.join(' ')}` : '';
          return textResult(
            `Wrote ${name.filename} (${rendered.mediaType}, ${rendered.bytes.byteLength} bytes). ${KEPT_LINE}${notes}`,
            {
              renkeiDocuments: [
                {
                  mediaType: rendered.mediaType,
                  dataBase64: rendered.bytes.toString('base64'),
                  title: name.filename,
                },
              ],
              // The model wrote this; it does not need to read it back.
              renkeiDocumentsShown: false,
            }
          );
        }
        const type = resolveMediaType(name.filename, input.contentType);
        if (!type.ok) return errorResult(type.reason);
        const bytes = Buffer.from(input.content, 'utf8');
        return textResult(
          `Wrote ${name.filename} (${type.mediaType}, ${bytes.byteLength} bytes). ${KEPT_LINE}`,
          {
            renkeiDocuments: [
              {
                mediaType: type.mediaType,
                dataBase64: bytes.toString('base64'),
                title: name.filename,
              },
            ],
            renkeiDocumentsShown: false,
          }
        );
      },
    },
    {
      def: {
        name: 'chat_write_binary_file',
        description:
          'Write a PNG, JPEG, TIFF or PDF you produced as raw bytes, for the person to keep (it appears under this chat’s Artifacts like any other file). ' +
          'Pass the file as plain base64 in content. Use this only when you can produce the format’s bytes yourself; for a chart or diagram use chat_write_chart, and for a PDF of ordinary prose use chat_write_file with Markdown. ' +
          `The bytes are validated and images are rebuilt from their pixels: metadata, text chunks and trailing data are removed, and a PDF containing scripts, launch/URI actions, attachments, forms or encryption is refused. At most ${BINARY_MAX_BYTES} bytes. ` +
          'If the file is refused, the reason says what to change.',
        inputSchema: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: `The name to save as; the extension names the format (${BINARY_EXTENSIONS.join(', ')}). A name, not a path.`,
            },
            content: {
              type: 'string',
              description: `The file's bytes as plain base64 (no data: prefix), at most ${BINARY_MAX_BASE64_CHARS} characters.`,
            },
          },
          required: ['filename', 'content'],
        },
      },
      async execute(input) {
        const name = checkFilename(input.filename);
        if (!name.ok) return errorResult(name.reason);
        if (typeof input.content !== 'string') {
          return errorResult('content must be a string — the file’s bytes as base64.');
        }
        const extension = extensionOf(name.filename);
        if (!extension || !isBinaryExtension(extension)) {
          return errorResult(
            `filename must end in one of: ${BINARY_EXTENSIONS.map((e) => `.${e}`).join(', ')}.`
          );
        }
        const checked = sanitizeBinary(extension, input.content);
        if (!checked.ok) return errorResult(`${name.filename} was not written: ${checked.reason}`);
        const notes = checked.notes.length ? `\n\nNote: ${checked.notes.join(' ')}` : '';
        return textResult(
          `Wrote ${name.filename} (${checked.mediaType}, ${checked.bytes.byteLength} bytes). ${KEPT_LINE}${notes}`,
          {
            renkeiDocuments: [
              {
                mediaType: checked.mediaType,
                dataBase64: checked.bytes.toString('base64'),
                title: name.filename,
              },
            ],
            renkeiDocumentsShown: false,
          }
        );
      },
    },
  ];
}
