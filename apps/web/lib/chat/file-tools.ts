/**
 * chat_write_file — the model's way to hand the person a file. Every
 * other file a chat keeps came from a tool (a screenshot, a mail
 * attachment) via `_meta.renkeiDocuments`; this tool puts the model's own
 * writing through the same door, so it lands under the chat's Artifacts
 * like any other, for download or copying to a network share.
 *
 * The model only ever writes text. A text format (CSV, Markdown, JSON,
 * …) is kept as written; a document format (.docx, .pdf, .pptx, .xlsx)
 * is RENDERED here from that text — Markdown for the three documents,
 * CSV / JSON / Markdown tables for the workbook — by a library that
 * produces a valid file deterministically (@renkei/document-render, also
 * used by sandbox_render_document for org agents). Bytes never travel
 * as tool arguments, which is the platform's rule everywhere, and the
 * model's cost is the same whether the result is a .csv or an .xlsx.
 * Offered only when the organization has a store to keep files in
 * (chat-local-tools.ts), so the model is never given a verb that can
 * only fail.
 */

import {
  extensionOf,
  isRenderedExtension,
  renderDocument,
  RENDER_INPUT_MAX_CHARS,
  resolveMediaType,
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
  ];
}
