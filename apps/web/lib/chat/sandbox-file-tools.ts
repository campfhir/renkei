/**
 * chat_attach_to_sandbox / chat_attach_from_sandbox — the two doors between
 * a chat's files and the person's sandbox scratch space, one each way.
 *
 * TO the sandbox: a file of this chat or its project — a person's upload,
 * or a file a tool handed back (a picture chat_generate_image drew, a
 * chart, a document chat_write_file wrote) — copied in so every sandbox_*
 * tool can act on its bytes: read or OCR it, send it to an upload slot,
 * and above all hand it to sandbox_run_python, which is how a picture
 * ends up inside a Word document or a slide deck. Named by attachment id,
 * or — since a file a tool made moments ago has no id the model has seen
 * — by its filename, or "last" for the newest file a tool made.
 *
 * FROM the sandbox: a staged file brought back under this chat's
 * Artifacts — the way what sandbox_run_python wrote under out/ (a
 * document richer than chat_write_file can render, an existing file
 * updated in place) reaches the person. The MCP sandbox tools answer only
 * ids and sizes, and only a local tool can attach a file to the chat
 * (`_meta.renkeiDocuments`, the door chat_write_file uses), so this one
 * reads the staged bytes back and hands them over the same way.
 *
 * Offered only where the chat has the sandbox in its toolset, the
 * deployment runs a sandbox worker, and the organization has a store to
 * keep files in (chat-local-tools.ts) — so the model is never given a
 * verb that can only fail.
 */

import { sbReadFile, sbWriteFile } from '@renkei/sandbox-client';
import { outputMediaType } from '@renkei/connector-sandbox';
import { findAttachment } from './attachment-tools';
import { fileCipherFor } from './artifact-access';
import {
  listAttachments,
  listProjectArtifacts,
  readAttachmentBytes,
  type AttachmentRow,
} from './attachments';
import type { ContentCipher } from './content-crypto';
import { formatByteSize } from '@/lib/byte-size';
import { logger } from '@/lib/logger';
import { checkFilename, KEPT_LINE } from './file-tools';
import { errorResult, textResult, type LocalTool, type LocalToolContext } from './local-tools';
import { DIGEST_INPUT_PROPERTIES, digestFieldsOf } from './artifact-digest-input';
import { chatFileMaxBytes } from './turn-store';

export const ATTACH_TO_SANDBOX_TOOL = 'chat_attach_to_sandbox';
export const ATTACH_FROM_SANDBOX_TOOL = 'chat_attach_from_sandbox';

/** How many names an "it is not there" message lists. */
const NAMES_LISTED = 12;
const LAST = new Set(['last', 'previous', 'latest']);

/** What the name picker needs of a stored file. */
export interface NamedFile {
  filename: string;
  /** 'model' for a file a tool made; anything else is the person's own upload. */
  origin: string;
}

export type NamePick<T extends NamedFile> = { ok: true; file: T } | { ok: false; reason: string };

/**
 * Which of the chat's files `wanted` names. `files` is oldest first, as
 * listAttachments returns them. "last" is the newest file a tool made,
 * else the newest file of any kind; a name is matched exactly (ignoring
 * case), then as a part of a name, newest first.
 */
export function pickByName<T extends NamedFile>(files: readonly T[], wanted: string): NamePick<T> {
  const newestFirst = [...files].reverse();
  if (newestFirst.length === 0) {
    return { ok: false, reason: 'There are no files in this chat to stage.' };
  }
  const name = wanted.trim().toLowerCase();
  if (LAST.has(name)) {
    return {
      ok: true,
      file: newestFirst.find((file) => file.origin === 'model') ?? newestFirst[0]!,
    };
  }
  const exact = newestFirst.find((file) => file.filename.toLowerCase() === name);
  if (exact) return { ok: true, file: exact };
  const partial = newestFirst.find((file) => file.filename.toLowerCase().includes(name));
  if (partial) return { ok: true, file: partial };
  const names = newestFirst
    .slice(0, NAMES_LISTED)
    .map((file) => file.filename)
    .join(', ');
  return {
    ok: false,
    reason: `No file called "${wanted}" in this chat. Its files, newest first: ${names}. Use one of those names, or "last".`,
  };
}

/** The chat's own files, then its project's, oldest first within each. */
async function filesOf(context: LocalToolContext): Promise<AttachmentRow[]> {
  const own = await listAttachments({ chatId: context.chatId });
  if (!context.projectId) return own;
  const shared = await listProjectArtifacts(context.projectId);
  return [...shared, ...own];
}

export function sandboxFileTools(): LocalTool[] {
  return [
    {
      def: {
        name: ATTACH_TO_SANDBOX_TOOL,
        description:
          'Copy a file of this chat or its project into your sandbox scratch space, so the ' +
          'sandbox_* tools can work with its bytes: read or OCR it, send it to an upload, and ' +
          'above all hand it to sandbox_run_python — the way a picture (one chat_generate_image ' +
          'drew, a chart, an upload) gets placed inside a document, or a file the person gave ' +
          'you gets updated in place. Name it by attachmentId, or by filename — the name a tool ' +
          'reported when it made the file, or "last" for the newest file a tool made in this ' +
          'chat. Returns the staged file’s id for the sandbox tools.',
        inputSchema: {
          type: 'object',
          properties: {
            attachmentId: {
              type: 'string',
              description:
                'The attachment’s id, when you have it (the person’s uploads are listed with theirs).',
            },
            filename: {
              type: 'string',
              description:
                'Else the file’s name in this chat (cover.png, report.docx), or "last" for the newest file a tool made.',
            },
          },
          required: [],
        },
      },
      async execute(input, context) {
        const id = typeof input.attachmentId === 'string' ? input.attachmentId.trim() : '';
        const wanted = typeof input.filename === 'string' ? input.filename.trim() : '';
        if (!id && !wanted) {
          return errorResult('Name the file: attachmentId, or filename (or "last").');
        }
        let file: {
          filename: string;
          contentType: string;
          blobKey: string;
          cipher: ContentCipher | null;
        };
        if (id) {
          const found = await findAttachment(context, id);
          if (!found) return errorResult('No such attachment in this chat.');
          file = found;
        } else {
          let rows: AttachmentRow[];
          try {
            rows = await filesOf(context);
          } catch (error) {
            logger.error('chat files could not be listed for the sandbox: {error}', {
              component: 'chat/sandbox-files',
              subject: context.subject,
              chatId: context.chatId,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            });
            return errorResult('This chat’s files could not be read just now.');
          }
          const picked = pickByName(rows, wanted);
          if (!picked.ok) return errorResult(picked.reason);
          file = { ...picked.file, cipher: await fileCipherFor(context, picked.file) };
        }
        if (!file.cipher) return errorResult('No key opens this file for you.');
        const object = await readAttachmentBytes(file, file.cipher);
        if (!object.ok) {
          return errorResult(
            object.err.type === 'UNCONFIGURED'
              ? 'No file store is configured.'
              : `The file could not be read (${object.err.type}).`
          );
        }
        const staged = await sbWriteFile(
          { subject: context.subject },
          { filename: file.filename, contentType: file.contentType, source: 'chat' },
          object.val
        );
        if (!staged.ok) return errorResult(`The sandbox refused the file (${staged.err.kind}).`);
        return textResult(
          `Staged ${staged.val.filename} in the sandbox as file ${staged.val.id} (${staged.val.sizeBytes} bytes, ${staged.val.contentType ?? file.contentType}).`
        );
      },
    },
    {
      def: {
        name: ATTACH_FROM_SANDBOX_TOOL,
        description:
          'Bring a file staged in your sandbox scratch space back to the person: it appears under ' +
          'this chat’s Artifacts, where they can download it or copy it to a connected network ' +
          'share, exactly like a file from chat_write_file. This is how what sandbox_run_python ' +
          'wrote under out/ — a document with pictures, a workbook with charts, an existing file ' +
          'updated in place — reaches them; the sandbox tools alone only stage. Name the staged ' +
          'file by the id the sandbox tool answered with.',
        inputSchema: {
          type: 'object',
          properties: {
            fileId: {
              type: 'string',
              description:
                'The staged file’s id, from sandbox_run_python’s result or sandbox_list_files.',
            },
            filename: {
              type: 'string',
              description:
                'Keep it under this name instead of the staged one (a name, not a path).',
            },
            ...DIGEST_INPUT_PROPERTIES,
          },
          required: ['fileId'],
        },
      },
      async execute(input, context) {
        const fileId = typeof input.fileId === 'string' ? input.fileId.trim() : '';
        if (!/^[0-9a-f-]{36}$/i.test(fileId)) {
          return errorResult('fileId must be a staged file’s id (sandbox_list_files shows them).');
        }
        const read = await sbReadFile({ subject: context.subject }, fileId);
        if (!read.ok) {
          return errorResult(
            read.err.kind === 'op' && read.err.status === 404
              ? 'No such file is staged in your sandbox — sandbox_list_files shows what is.'
              : `The sandbox could not answer the file (${read.err.kind}).`
          );
        }
        const name = checkFilename(
          typeof input.filename === 'string' && input.filename.trim()
            ? input.filename
            : read.val.filename
        );
        if (!name.ok) return errorResult(name.reason);
        const bytes = read.val.bytes;
        if (bytes.byteLength === 0)
          return errorResult(`${name.filename} is empty; nothing to keep.`);
        const maxBytes = await chatFileMaxBytes();
        if (bytes.byteLength > maxBytes) {
          return errorResult(
            `${name.filename} is ${bytes.byteLength} bytes; a chat keeps files up to ${formatByteSize(maxBytes)}. Send it to a network share with sandbox_send_to_upload instead.`
          );
        }
        // The worker's type when it knows one; else by the extension, as a
        // script's output is typed on its way in (application/octet-stream
        // is the worker not knowing either).
        const declared = (read.val.contentType || '').split(';')[0]!.trim().toLowerCase();
        const mediaType =
          declared && declared !== 'application/octet-stream'
            ? declared
            : outputMediaType(name.filename);
        return textResult(
          `Kept ${name.filename} (${mediaType}, ${bytes.byteLength} bytes). ${KEPT_LINE}`,
          {
            renkeiDocuments: [
              {
                mediaType,
                dataBase64: Buffer.from(bytes).toString('base64'),
                title: name.filename,
                ...digestFieldsOf(input),
              },
            ],
            // The model made it (or asked for it); it does not need to read it back.
            renkeiDocumentsShown: false,
          }
        );
      },
    },
  ];
}
