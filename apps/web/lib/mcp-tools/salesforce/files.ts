/**
 * The salesforce_ file tools: a record's files to and from the caller's
 * sandbox scratch space, server to server — the bytes never pass through
 * the model (the WebEx/OnBase attachment shape; docs/sandbox-connector-design.md).
 *
 * Salesforce Files: a ContentDocument is the file, each ContentVersion one
 * version of it (VersionData the bytes), and ContentDocumentLink ties a
 * document to the records it is shared with. salesforce_download_file
 * stages a file's latest version — one named by id, or each file on a
 * record — and salesforce_attach_file inserts a ContentVersion from a
 * staged file, published to the first record named and linked to the rest.
 *
 * A file linked to a record of an object the connector hides is refused,
 * whichever way it is reached. Registered only where the deployment runs a
 * sandbox worker: without one there is nowhere to put the bytes.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { DEFAULT_MAX_FILE_BYTES, validateFilename } from '@renkei/connector-sandbox';
import { isSalesforceId, keyPrefix, soqlString, to18 } from '@renkei/connector-salesforce';
import {
  clientFailure,
  sandboxConfig,
  sbReadFile,
  sbWriteFile,
} from '@/lib/sandbox/service-client';
import { logger } from '@/lib/logger';
import type { MCPToolContext } from '../common';
import { fileLine } from '../sandbox/shared';
import type { SalesforceAuth } from './salesforce-auth';
import {
  errText,
  readAccess,
  rec,
  recordUrl,
  sfDownload,
  sfQuery,
  sfRequest,
  str,
  textResult,
  type SalesforceAccess,
} from './client';
import { hiddenObjectOfId } from './schema';
import { resolveRef } from './records';
import { limitField, objectField, recordField, recordRefField } from './fields';

/**
 * Salesforce's REST insert takes VersionData as base64 inside JSON, whose
 * request limit puts the file itself at about 37.5 MB.
 */
export const MAX_SALESFORCE_UPLOAD_BYTES = 37_500_000;

interface FileVersion {
  versionId: string;
  documentId: string;
  title: string;
  extension: string;
  size: number;
}

function versionOf(row: Record<string, unknown>): FileVersion {
  return {
    versionId: str(row.Id),
    documentId: str(row.ContentDocumentId),
    title: str(row.Title) || 'file',
    extension: str(row.FileExtension),
    size: typeof row.ContentSize === 'number' ? row.ContentSize : 0,
  };
}

const VERSION_FIELDS = 'Id, ContentDocumentId, Title, FileExtension, ContentSize';

/** A file's latest version, by a ContentDocument (069) or ContentVersion (068) id. */
async function versionById(
  context: MCPToolContext,
  access: SalesforceAccess,
  id: string
): Promise<FileVersion | string> {
  const prefix = keyPrefix(id);
  const where =
    prefix === '069'
      ? `ContentDocumentId = ${soqlString(to18(id))} AND IsLatest = true`
      : prefix === '068'
        ? `Id = ${soqlString(to18(id))}`
        : null;
  if (!where) return `${id} is not a file id (a ContentDocument 069… or ContentVersion 068… id).`;
  const found = await sfQuery(
    context,
    access,
    `SELECT ${VERSION_FIELDS} FROM ContentVersion WHERE ${where} LIMIT 1`
  );
  if (!found.ok) return found.error;
  const row = found.records[0];
  return row ? versionOf(row) : `No file ${id} is visible to your Salesforce user.`;
}

/** Why the policy keeps a file away (it is linked to a hidden object's record), or null. */
async function hiddenByLinks(
  context: MCPToolContext,
  access: SalesforceAccess,
  documentId: string
): Promise<string | null> {
  if (access.policy.excludedObjects.length === 0) return null;
  const links = await sfQuery(
    context,
    access,
    `SELECT LinkedEntityId FROM ContentDocumentLink WHERE ContentDocumentId = ${soqlString(documentId)}`
  );
  if (!links.ok) return links.error;
  for (const link of links.records) {
    const hidden = await hiddenObjectOfId(context, access, str(link.LinkedEntityId));
    if (hidden && typeof hidden === 'object') return hidden.error;
    if (hidden) {
      return `Your organization keeps ${hidden} away from the assistant, and this file is attached to one of its records.`;
    }
  }
  return null;
}

/** A name the scratch space accepts, from the file's title and extension. */
function stagedName(version: FileVersion, ordinal: number): string {
  const base = version.title.replace(/[/\\\0]/g, '_');
  const named =
    version.extension && !base.toLowerCase().endsWith(`.${version.extension.toLowerCase()}`)
      ? `${base}.${version.extension}`
      : base;
  const valid = validateFilename(named);
  return valid.ok
    ? valid.filename
    : `salesforce-file-${ordinal}${version.extension ? `.${version.extension}` : ''}`;
}

export function registerFileTools(
  server: McpServer,
  context: MCPToolContext,
  auth: SalesforceAuth
): void {
  if (sandboxConfig() === null) return;

  server.registerTool(
    'salesforce_download_file',
    {
      title: 'Salesforce · Act — Download files into your scratch space',
      description:
        'Stage Salesforce Files in your sandbox scratch space, server to server — the bytes never ' +
        'pass through the model. Name one file by its id (069… or 068…), or a record to stage the ' +
        'files on it, newest first. Each staged file answers with an id: sandbox_read_file ' +
        'extracts its text, sandbox_send_to_upload forwards it to another connector, and ' +
        'salesforce_attach_file attaches it to another record. Staged files expire after a day.',
      // Writes to the caller's scratch space, never to Salesforce — but it
      // is a write, so org read-only mode disables it.
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        file: z
          .string()
          .optional()
          .describe('A file’s ContentDocument (069…) or ContentVersion (068…) id.'),
        object: objectField.optional().describe('The record’s object, when it is named by name.'),
        record: recordField.optional().describe('A record whose files to stage, instead of file.'),
        limit: limitField(10, 5),
      }),
    },
    async (args) => {
      const access = await readAccess(auth);
      if (typeof access === 'string') return errText(access);
      if (!context.subject) return errText('No signed-in identity on this request.');
      const target = { subject: context.subject };

      let versions: FileVersion[];
      let from: string;
      if (args.file) {
        const file = args.file.trim();
        if (!isSalesforceId(file)) return errText(`${file} is not a file id.`);
        const version = await versionById(context, access, file);
        if (typeof version === 'string') return errText(version);
        versions = [version];
        from = version.documentId;
      } else if (args.record) {
        const found = await resolveRef(context, access, {
          object: args.object,
          record: args.record,
        });
        if (typeof found === 'string') return errText(found);
        const links = await sfQuery(
          context,
          access,
          `SELECT ContentDocumentId FROM ContentDocumentLink WHERE LinkedEntityId = ${soqlString(found.id)} ORDER BY ContentDocument.CreatedDate DESC LIMIT ${args.limit ?? 5}`
        );
        if (!links.ok) return errText(links.error);
        if (links.records.length === 0) {
          return textResult(`${found.describe.label} ${found.name} has no files.`);
        }
        const ids = links.records.map((link) => soqlString(str(link.ContentDocumentId)));
        const latest = await sfQuery(
          context,
          access,
          `SELECT ${VERSION_FIELDS} FROM ContentVersion WHERE ContentDocumentId IN (${ids.join(', ')}) AND IsLatest = true`
        );
        if (!latest.ok) return errText(latest.error);
        versions = latest.records.map(versionOf);
        from = found.id;
      } else {
        return errText('Name a file by its id, or a record whose files to stage.');
      }

      const maxBytes = context.maxAttachmentBytes ?? DEFAULT_MAX_FILE_BYTES;
      const lines: string[] = [];
      let staged = 0;
      for (const [index, version] of versions.entries()) {
        const label = `"${version.title}" (${version.documentId})`;
        const refused = await hiddenByLinks(context, access, version.documentId);
        if (refused) {
          lines.push(`Skipped ${label}: ${refused}`);
          continue;
        }
        if (version.size > maxBytes) {
          lines.push(
            `Skipped ${label}: ${version.size} bytes is over this org’s ${maxBytes}-byte file limit.`
          );
          continue;
        }
        const fetched = await sfDownload(
          context,
          access,
          `/sobjects/ContentVersion/${encodeURIComponent(version.versionId)}/VersionData`,
          maxBytes
        );
        if (!fetched.ok) {
          lines.push(`Could not fetch ${label}: ${fetched.error}`);
          continue;
        }
        const written = await sbWriteFile(
          target,
          {
            filename: stagedName(version, index + 1),
            ...(fetched.contentType ? { contentType: fetched.contentType } : {}),
            source: `salesforce:${access.connector}:${version.versionId}`,
          },
          fetched.bytes
        );
        if (!written.ok) {
          lines.push(`Could not stage ${label}: ${clientFailure(written.err).message}`);
          continue;
        }
        staged += 1;
        lines.push(`Staged ${label}: ${fileLine(written.val)}`);
      }
      logger.info('salesforce_download_file staged', {
        component: 'mcp/tool',
        from,
        staged,
        attempted: versions.length,
      });
      if (staged === 0) return errText(lines.join('\n'));
      return textResult(
        `${staged} of ${versions.length} file(s) staged from Salesforce ${access.connectorName}:\n${lines.join('\n')}`
      );
    }
  );

  server.registerTool(
    'salesforce_attach_file',
    {
      title: 'Salesforce · Act — Attach a staged file to records',
      description:
        'Upload a file from your sandbox scratch space to Salesforce Files and attach it to a ' +
        'record — and, optionally, share it to up to five more records (the same file, not ' +
        'copies). Anyone who can see those records can open it. The file is checked against ' +
        'the org’s size limit before anything is sent.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        fileId: z.string().min(1).describe('The staged file’s id, from your scratch space.'),
        object: objectField.optional().describe('The record’s object, when it is named by name.'),
        record: recordField,
        alsoOn: z
          .array(recordRefField)
          .max(5)
          .optional()
          .describe('More records to share the same file to.'),
        title: z.string().max(255).optional().describe('The file’s title; default its filename.'),
      }),
    },
    async (args) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      if (!context.subject) return errText('No signed-in identity on this request.');

      const first = await resolveRef(context, access, { object: args.object, record: args.record });
      if (typeof first === 'string') return errText(first);
      const more: { id: string; label: string }[] = [];
      for (const ref of args.alsoOn ?? []) {
        const found = await resolveRef(context, access, ref);
        if (typeof found === 'string') return errText(found);
        if (found.id !== first.id && !more.some((entry) => entry.id === found.id)) {
          more.push({ id: found.id, label: `${found.describe.label} ${found.name}` });
        }
      }

      const read = await sbReadFile({ subject: context.subject }, args.fileId);
      if (!read.ok) return errText(clientFailure(read.err).message);
      const limit = Math.min(
        context.maxAttachmentBytes ?? DEFAULT_MAX_FILE_BYTES,
        MAX_SALESFORCE_UPLOAD_BYTES
      );
      if (read.val.bytes.byteLength === 0) return errText(`"${read.val.filename}" is empty.`);
      if (read.val.bytes.byteLength > limit) {
        return errText(
          `"${read.val.filename}" is ${read.val.bytes.byteLength} bytes, over the ${limit}-byte limit for a Salesforce upload here.`
        );
      }
      const inserted = await sfRequest(context, access, 'POST', '/sobjects/ContentVersion', {
        Title: args.title?.trim() || read.val.filename.replace(/\.[^.]+$/, '') || read.val.filename,
        PathOnClient: read.val.filename,
        VersionData: Buffer.from(read.val.bytes).toString('base64'),
        FirstPublishLocationId: first.id,
      });
      if (!inserted.ok) return errText(`Salesforce did not take the file: ${inserted.error}`);
      const versionId = str(rec(inserted.body).id);
      const version = await sfQuery(
        context,
        access,
        `SELECT ContentDocumentId FROM ContentVersion WHERE Id = ${soqlString(versionId)} LIMIT 1`
      );
      const documentId = version.ok ? str(version.records[0]?.ContentDocumentId) : '';
      const lines = [
        `Attached "${read.val.filename}" to ${first.describe.label} ${first.name} — ${recordUrl(access, first.id)}` +
          (documentId ? ` (file ${documentId})` : ''),
      ];
      for (const entry of more) {
        if (!documentId) {
          lines.push(`Not shared to ${entry.label}: the new file’s id could not be read back.`);
          continue;
        }
        const linked = await sfRequest(context, access, 'POST', '/sobjects/ContentDocumentLink', {
          ContentDocumentId: documentId,
          LinkedEntityId: entry.id,
          ShareType: 'V',
          Visibility: 'InternalUsers',
        });
        lines.push(
          linked.ok
            ? `Shared to ${entry.label} — ${recordUrl(access, entry.id)}`
            : `Not shared to ${entry.label}: ${linked.error}`
        );
      }
      logger.info('salesforce_attach_file attached', {
        component: 'mcp/tool',
        record: first.id,
        shared: more.length,
      });
      return textResult(lines.join('\n'));
    }
  );
}
