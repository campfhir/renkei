/**
 * Where uploaded bytes actually go. The /api/upload route authenticates and
 * claims a slot, then hands the bytes here; each executor forwards them to
 * the slot's destination UNDER THE REQUESTING USER'S OWN STORED GRANTS —
 * the same resolution the MCP transport uses, so an upload can do nothing
 * its requester's tools could not.
 *
 * No token is read here (docs/delegate-key-design.md): every provider call
 * rides an `AuthedFetch` from the delegate, which attaches the credential,
 * refreshes it when due and retries once on a 401; OnBase calls name the
 * uploader by subject and the delegate attaches their token on the way to
 * the OnBase worker.
 *
 * Every upstream call is bounded (jiraFetch/confluence/graph carry the
 * fetch-guard timeouts; upload-session chunks carry their own).
 */

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '@renkei/db';
import { ATLASSIAN, ATLASSIAN_JSM, readAtlassianMetadata } from '@renkei/provider-grants';
import { delegateGrants, grantFetch, type AuthedFetch } from '@renkei/delegate-client';
import { graphUploadViaSession } from '@renkei/connector-microsoft';
import { childPath as fileshareChildPath } from '@renkei/connector-fileshares';
import { clientFailure, fsWriteFile } from '@/lib/file-shares/service-client';
import { obApi, obPutBytes } from '@/lib/onbase/service-client';
import { onbaseFailureText, ONBASE_LABEL } from '@/lib/mcp-tools/onbase/onbase-auth';
import { refusalTextOf } from '@/lib/grant-refusals';
import { jiraFetch } from '@/lib/mcp-tools/common';
import {
  graphPost,
  graphPutContent,
  resolveGraphAccess,
  str,
  rec,
} from '@/lib/mcp-tools/graph/client';
import { confluenceUpload, resolveConfluenceAccess } from '@/lib/mcp-tools/confluence/client';
import { resolveWebexAccess } from '@/lib/mcp-tools/webex/webex-auth';
import { recordSentWebexMessage } from '@/lib/mcp-tools/webex/sent-ledger';
import { WebexClient, type OutgoingFile } from '@renkei/connector-webex';
import { webexBotClient } from '@/lib/webex-bot';
import { logger } from '@/lib/logger';
import { timeoutSignal, UPLOAD_TIMEOUT_MS, isTimeoutError } from '@/lib/mcp-tools/fetch-guard';
import type { MCPToolContext } from '@/lib/mcp-tools/common';

/** Graph's simple-PUT ceiling for drive items; past it → upload session. */
const DRIVE_SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
/** Graph's inline fileAttachment ceiling for messages; past it → session. */
const MESSAGE_ATTACHMENT_INLINE_MAX = 3 * 1024 * 1024;
const WEBEX_API_BASE = 'https://webexapis.com/v1';

export interface UploadSlotRow {
  id: string;
  subject: string;
  account_id: string;
  kind: string;
  destination: unknown;
  filename: string;
  content_type: string | null;
}

export interface UploadOutcome {
  ok: boolean;
  detail: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function destinationOf(slot: UploadSlotRow): Record<string, unknown> {
  return isRecord(slot.destination) ? slot.destination : {};
}

/**
 * The Atlassian gateway fetcher + cloud id for a slot: the JSM grant when
 * the kind wants it and the user connected one, otherwise the main Jira
 * grant. The delegate's `describe` is the existence probe and the source
 * of the cloud id; the fetcher it hands back refreshes on its own.
 */
async function resolveAtlassian(
  slot: UploadSlotRow,
  preferJsm: boolean
): Promise<{ auth: AuthedFetch; cloudId: string } | string> {
  const candidates: { provider: string; subject?: string; accountId?: string }[] = [];
  if (preferJsm) candidates.push({ provider: ATLASSIAN_JSM, subject: slot.subject });
  candidates.push({ provider: ATLASSIAN, accountId: slot.account_id });

  for (const candidate of candidates) {
    const grant = { ...candidate };
    const described = await delegateGrants().describe(grant);
    if (!described.ok) continue;
    const site = readAtlassianMetadata(described.val.metadata);
    if (!site.cloudId) continue;
    return {
      auth: grantFetch({ ...grant, accountId: described.val.accountId }),
      cloudId: site.cloudId,
    };
  }
  return 'No usable Atlassian grant for this upload — reconnect Jira and request a new endpoint.';
}

function graphContextOf(slot: UploadSlotRow): { tenantId: string; subject: string } {
  return { subject: slot.subject };
}

async function jiraAttachment(slot: UploadSlotRow, bytes: Buffer): Promise<UploadOutcome> {
  const issueKey = str(destinationOf(slot).issueKey);
  if (!issueKey) return { ok: false, detail: 'The upload slot carries no issue key.' };
  const access = await resolveAtlassian(slot, false);
  if (typeof access === 'string') return { ok: false, detail: access };

  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(bytes)]), slot.filename);
  try {
    const response = await jiraFetch(
      `https://api.atlassian.com/ex/jira/${access.cloudId}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`,
      access.auth,
      { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, body: formData }
    );
    await response.text().catch(() => '');
    return { ok: true, detail: `Attached "${slot.filename}" to ${issueKey}.` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function jsmAttachment(slot: UploadSlotRow, bytes: Buffer): Promise<UploadOutcome> {
  const requestKey = str(destinationOf(slot).requestKey);
  if (!requestKey) return { ok: false, detail: 'The upload slot carries no request key.' };
  const access = await resolveAtlassian(slot, true);
  if (typeof access === 'string') return { ok: false, detail: access };
  const base = `https://api.atlassian.com/ex/jira/${access.cloudId}`;

  try {
    // The servicedeskapi flow is two-legged: multipart to the SERVICE DESK's
    // attachTemporaryFile, then attach the returned temporary ids to the
    // request as JSON (ported from the retired jsm_add_request_attachment).
    const reqResponse = await jiraFetch(
      `${base}/rest/servicedeskapi/request/${encodeURIComponent(requestKey)}`,
      access.auth
    );
    const reqBody = rec(await reqResponse.json().catch(() => ({})));
    const serviceDeskId = str(reqBody.serviceDeskId);
    if (!serviceDeskId) {
      return { ok: false, detail: `Could not resolve the service desk of ${requestKey}.` };
    }

    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(bytes)]), slot.filename);
    const upload = await jiraFetch(
      `${base}/rest/servicedeskapi/servicedesk/${serviceDeskId}/attachTemporaryFile`,
      access.auth,
      { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, body: formData }
    );
    const uploaded = rec(await upload.json().catch(() => ({})));
    const temporaryAttachmentIds = Array.isArray(uploaded.temporaryAttachments)
      ? uploaded.temporaryAttachments
          .map((entry) => str(rec(entry).temporaryAttachmentId))
          .filter(Boolean)
      : [];
    if (temporaryAttachmentIds.length === 0) {
      return { ok: false, detail: 'Upload succeeded but returned no attachment id.' };
    }

    const attach = await jiraFetch(
      `${base}/rest/servicedeskapi/request/${encodeURIComponent(requestKey)}/attachment`,
      access.auth,
      {
        method: 'POST',
        body: JSON.stringify({ temporaryAttachmentIds, public: true }),
      }
    );
    await attach.text().catch(() => '');
    return { ok: true, detail: `Attached "${slot.filename}" to ${requestKey}.` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function confluenceAttachment(slot: UploadSlotRow, bytes: Buffer): Promise<UploadOutcome> {
  const destination = destinationOf(slot);
  const contentId = str(destination.contentId);
  if (!contentId) return { ok: false, detail: 'The upload slot carries no content id.' };
  // resolveConfluenceAccess reads only tenantId + subject from the context.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const access = await resolveConfluenceAccess(graphContextOf(slot) as MCPToolContext);
  if (typeof access === 'string') return { ok: false, detail: access };

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]), slot.filename);
  if (str(destination.comment)) form.append('comment', str(destination.comment));
  const result = await confluenceUpload(
    graphContextOf(slot),
    access,
    `/rest/api/content/${encodeURIComponent(contentId)}/child/attachment`,
    form
  );
  if (!result.ok) return { ok: false, detail: result.error };
  return { ok: true, detail: `Uploaded "${slot.filename}" to ${contentId}.` };
}

async function driveDocument(slot: UploadSlotRow, bytes: Buffer): Promise<UploadOutcome> {
  const destination = destinationOf(slot);
  const driveId = str(destination.driveId);
  const parentItemId = str(destination.parentItemId);
  if (!driveId || !parentItemId) {
    return { ok: false, detail: 'The upload slot carries no drive destination.' };
  }
  const access = await resolveGraphAccess(graphContextOf(slot));
  if (typeof access === 'string') return { ok: false, detail: access };

  const conflict = str(destination.ifNameTaken) || 'rename';
  const name = encodeURIComponent(slot.filename);
  const payload = new Uint8Array(bytes);
  if (payload.byteLength <= DRIVE_SIMPLE_UPLOAD_MAX) {
    const uploaded = await graphPutContent(
      graphContextOf(slot),
      access.auth,
      `/drives/${driveId}/items/${parentItemId}:/${name}:/content` +
        `?@microsoft.graph.conflictBehavior=${conflict}`,
      payload,
      slot.content_type || 'application/octet-stream'
    );
    if (!uploaded.ok) return { ok: false, detail: uploaded.error };
    return {
      ok: true,
      detail: `Uploaded "${str(uploaded.body.name) || slot.filename}" — itemId: ${str(uploaded.body.id)}.`,
    };
  }
  // Past the simple-PUT ceiling Graph requires an upload session.
  const uploaded = await graphUploadViaSession(
    access.auth,
    `/drives/${driveId}/items/${parentItemId}:/${name}:/createUploadSession`,
    { item: { '@microsoft.graph.conflictBehavior': conflict, name: slot.filename } },
    payload,
    { lane: 'interactive' }
  );
  if (!uploaded.ok) {
    return { ok: false, detail: str(rec(uploaded.err).message) || 'Graph upload session failed.' };
  }
  return {
    ok: true,
    detail: `Uploaded "${str(uploaded.val.name) || slot.filename}" — itemId: ${str(uploaded.val.id)}.`,
  };
}

async function outlookDraftAttachment(slot: UploadSlotRow, bytes: Buffer): Promise<UploadOutcome> {
  const draftId = str(destinationOf(slot).draftId);
  if (!draftId) return { ok: false, detail: 'The upload slot carries no draft id.' };
  const access = await resolveGraphAccess(graphContextOf(slot));
  if (typeof access === 'string') return { ok: false, detail: access };

  if (bytes.byteLength <= MESSAGE_ATTACHMENT_INLINE_MAX) {
    const result = await graphPost(
      graphContextOf(slot),
      access.auth,
      `/me/messages/${encodeURIComponent(draftId)}/attachments`,
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: slot.filename,
        contentType: slot.content_type || 'application/octet-stream',
        contentBytes: bytes.toString('base64'),
      }
    );
    if (!result.ok) return { ok: false, detail: result.error };
    return { ok: true, detail: `Attached "${slot.filename}" to the draft.` };
  }
  const uploaded = await graphUploadViaSession(
    access.auth,
    `/me/messages/${encodeURIComponent(draftId)}/attachments/createUploadSession`,
    {
      AttachmentItem: {
        attachmentType: 'file',
        name: slot.filename,
        size: bytes.byteLength,
        ...(slot.content_type ? { contentType: slot.content_type } : {}),
      },
    },
    new Uint8Array(bytes),
    { lane: 'interactive' }
  );
  if (!uploaded.ok) {
    return { ok: false, detail: str(rec(uploaded.err).message) || 'Graph upload session failed.' };
  }
  return { ok: true, detail: `Attached "${slot.filename}" to the draft.` };
}

/**
 * WebEx multipart send: the one file WebEx allows per message, alongside
 * whatever roomId/toPersonEmail/markdown/parentId webex_request_attachment_
 * upload recorded as the destination. resolveWebexAccess reads only
 * tenantId + subject, which is all a slot row carries — the multipart POST
 * itself goes through the grant's fetcher, which attaches the credential.
 */
async function webexAttachment(slot: UploadSlotRow, bytes: Buffer): Promise<UploadOutcome> {
  const destination = destinationOf(slot);
  if (destination.noteToSelf === true) return webexNoteToSelfAttachment(slot, bytes);
  const roomId = str(destination.roomId);
  const toPersonEmail = str(destination.toPersonEmail);
  if (!roomId && !toPersonEmail) {
    return { ok: false, detail: 'The upload slot carries no room or recipient.' };
  }
  const access = await resolveWebexAccess(graphContextOf(slot));
  if (typeof access === 'string') return { ok: false, detail: access };

  const form = new FormData();
  form.append(roomId ? 'roomId' : 'toPersonEmail', roomId || toPersonEmail);
  if (str(destination.parentId)) form.append('parentId', str(destination.parentId));
  if (str(destination.markdown)) form.append('markdown', str(destination.markdown));
  form.append(
    'files',
    new Blob([new Uint8Array(bytes)], { type: slot.content_type || 'application/octet-stream' }),
    slot.filename
  );

  let response: Response;
  try {
    response = await access.auth(`${WEBEX_API_BASE}/messages`, {
      method: 'POST',
      body: form,
      signal: timeoutSignal(undefined, UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      detail: isTimeoutError(error)
        ? `WebEx did not respond within ${UPLOAD_TIMEOUT_MS}ms.`
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
  const refused = refusalTextOf(response, 'WebEx');
  if (refused) return { ok: false, detail: refused };
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      ok: false,
      detail: `WebEx API answered ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}.`,
    };
  }
  // Posted as the user, so the ledger must know it — or their own webhook
  // re-ingests it as something they typed (see sent-ledger.ts).
  const sent = rec(await response.json().catch(() => ({})));
  await recordSentWebexMessage(slot.tenant_id, str(sent.id), slot.account_id);
  return { ok: true, detail: `Attached "${slot.filename}" to the WebEx message.` };
}

/**
 * A file the user asked to have sent to themself, in the same order
 * webex_note_to_self delivers text: as a direct message from the org's bot
 * when there is one (it arrives unread — lib/webex-bot.ts says why), else
 * into the user's own "Note to Self" space on their grant. The bytes
 * could not ride the tool call, so the two-step delivery happens here at
 * byte-arrival time instead.
 */
async function webexNoteToSelfAttachment(
  slot: UploadSlotRow,
  bytes: Buffer
): Promise<UploadOutcome> {
  const access = await resolveWebexAccess(graphContextOf(slot));
  if (typeof access === 'string') return { ok: false, detail: access };
  const markdown = str(destinationOf(slot).markdown) || undefined;
  const file: OutgoingFile = {
    filename: slot.filename,
    ...(slot.content_type ? { contentType: slot.content_type } : {}),
    bytes: new Uint8Array(bytes),
  };

  const bot = await webexBotClient(slot.tenant_id);
  if (bot && access.personEmail) {
    const viaBot = await bot.postMessage({ toPersonEmail: access.personEmail, markdown, file });
    if (viaBot.ok && viaBot.val.roomId) {
      await recordSentWebexMessage(slot.tenant_id, viaBot.val.id, slot.account_id);
      return {
        ok: true,
        detail: `Sent "${slot.filename}" as a direct message from the org's WebEx bot.`,
      };
    }
    logger.warn('webex note-to-self upload: the bot could not deliver; posting to the solo space', {
      component: 'upload-executors',
      reason: viaBot.ok ? 'no roomId in the bot response' : viaBot.err.message,
    });
  }

  const user = new WebexClient(access.auth, { lane: 'interactive' });
  const sent = await user.sendNoteToSelf(markdown ?? '', file);
  if (!sent.ok) return { ok: false, detail: sent.err.message ?? 'WebEx refused the note.' };
  await recordSentWebexMessage(slot.tenant_id, sent.val.id, slot.account_id);
  return {
    ok: true,
    detail: `Sent "${slot.filename}" to your "Note to Self" space (room ${sent.val.roomId}).`,
  };
}

/**
 * File-share write: the fileshare worker resolves the CALLER'S own stored
 * credential at byte-arrival time — a connection removed between slot mint
 * and POST means the write fails, since a slot must never outlive the
 * access that minted it — and the file server judges the write as that
 * account. This executor only names the destination.
 */
async function fileshareFile(slot: UploadSlotRow, bytes: Buffer): Promise<UploadOutcome> {
  const destination = destinationOf(slot);
  const shareId = str(destination.shareId);
  const folder = str(destination.path) || '/';
  if (!shareId) return { ok: false, detail: 'The upload slot carries no share destination.' };

  const target = fileshareChildPath(folder, slot.filename);
  const written = await fsWriteFile(
    { shareId, subject: slot.subject },
    target,
    new Uint8Array(bytes)
  );
  if (!written.ok) {
    if (
      written.err.kind === 'op' &&
      (written.err.type === 'no_share' || written.err.type === 'not_connected')
    ) {
      return { ok: false, detail: 'That share is no longer connected for you.' };
    }
    if (written.err.kind === 'op' && written.err.type === 'access_denied') {
      return { ok: false, detail: 'The file server refused the write with your credentials.' };
    }
    return { ok: false, detail: clientFailure(written.err).message };
  }
  return { ok: true, detail: `Wrote "${slot.filename}" to ${folder} on the share.` };
}

/**
 * Stage uploaded bytes into OnBase (POST /documents/uploads, then the file
 * parts), and record the staging reference on the slot so
 * onbase_archive_document can complete the three-step archive. Nothing is
 * a document yet — OnBase stores staged files transiently until archived.
 *
 * Every call names the uploader by subject: the delegate opens their
 * OnBase grant (refreshing it, and retrying once on a 401 — the tools'
 * session-lifecycle defensiveness, now the delegate's) and the worker
 * reuses their OnBase session rather than opening one (and taking a
 * license) per chunk of a multi-part upload.
 */
async function onbaseDocument(
  db: Kysely<DB>,
  slot: UploadSlotRow,
  bytes: Buffer
): Promise<UploadOutcome> {
  const extension = slot.filename.includes('.')
    ? slot.filename.slice(slot.filename.lastIndexOf('.') + 1)
    : 'dat';
  const staged = await obApi({
    subject: slot.subject,
    method: 'POST',
    path: '/documents/uploads',
    body: { fileExtension: extension, fileSize: bytes.byteLength },
  });
  if (!staged.ok) return { ok: false, detail: onbaseFailureText(staged.err, ONBASE_LABEL) };
  if (staged.val.status < 200 || staged.val.status >= 300) {
    return { ok: false, detail: `OnBase refused to stage the upload (${staged.val.status}).` };
  }
  let stagingRef: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(staged.val.body);
    if (isRecord(parsed)) stagingRef = parsed;
  } catch {
    // handled by the id check below
  }
  const onbaseUploadId = str(stagingRef.id);
  if (!onbaseUploadId) {
    return { ok: false, detail: 'OnBase staged the upload but returned no reference.' };
  }

  // Respect the server's part size; a single part when it names none.
  const filePartSize =
    typeof stagingRef.filePartSize === 'number' && stagingRef.filePartSize > 0
      ? stagingRef.filePartSize
      : bytes.byteLength;
  const partCount = Math.max(1, Math.ceil(bytes.byteLength / filePartSize));
  for (let part = 0; part < partCount; part += 1) {
    const chunk = bytes.subarray(part * filePartSize, (part + 1) * filePartSize);
    const put = await obPutBytes({
      subject: slot.subject,
      uploadId: onbaseUploadId,
      filePart: part + 1,
      bytes: new Uint8Array(chunk),
    });
    if (!put.ok) return { ok: false, detail: onbaseFailureText(put.err, ONBASE_LABEL) };
    if (put.val.status < 200 || put.val.status >= 300) {
      return {
        ok: false,
        detail: `OnBase refused file part ${part + 1} of ${partCount} (${put.val.status}).`,
      };
    }
  }

  // The staging reference rides the slot so the archive step can find it.
  const destination = destinationOf(slot);
  await db
    .updateTable('upload_slots')
    .set({ destination: JSON.stringify({ ...destination, onbaseUploadId }) })
    .where('id', '=', slot.id)
    .execute();

  return {
    ok: true,
    detail:
      `Staged "${slot.filename}" (${bytes.byteLength} bytes) in OnBase. Complete it with ` +
      `onbase_archive_document using uploadId "${slot.id}", a document type, and keywords.`,
  };
}

/**
 * Record an outcome on a claimed slot — the status/result write every
 * caller needs after executeUpload runs (or after a caller-side refusal,
 * like an oversized `sandbox_send_to_upload` payload, that never reaches
 * executeUpload at all). Split out so /api/upload/[slotId]'s token-claimed
 * POST and sandbox_send_to_upload's ownership-claimed tool call share one
 * finish path instead of two copies of the same UPDATE.
 */
export async function finalizeUploadSlot(
  db: Kysely<DB>,
  slot: { id: string },
  outcome: UploadOutcome
): Promise<UploadOutcome> {
  await db
    .updateTable('upload_slots')
    .set({
      status: outcome.ok ? 'completed' : 'failed',
      result: outcome.detail,
      completed_at: sql`NOW()`,
    })
    .where('id', '=', slot.id)
    .execute();
  return outcome;
}

/** executeUpload, then finalizeUploadSlot — the common case for both callers. */
export async function completeUploadSlot(
  db: Kysely<DB>,
  slot: UploadSlotRow,
  bytes: Buffer
): Promise<UploadOutcome> {
  return finalizeUploadSlot(db, slot, await executeUpload(db, slot, bytes));
}

export async function executeUpload(
  db: Kysely<DB>,
  slot: UploadSlotRow,
  bytes: Buffer
): Promise<UploadOutcome> {
  switch (slot.kind) {
    case 'jira-attachment':
      return jiraAttachment(slot, bytes);
    case 'jsm-attachment':
      return jsmAttachment(slot, bytes);
    case 'confluence-attachment':
      return confluenceAttachment(slot, bytes);
    case 'onedrive-document':
    case 'sharepoint-document':
      return driveDocument(slot, bytes);
    case 'outlook-draft-attachment':
      return outlookDraftAttachment(slot, bytes);
    case 'fileshare-file':
      return fileshareFile(slot, bytes);
    case 'onbase-document':
      return onbaseDocument(db, slot, bytes);
    case 'webex-attachment':
      return webexAttachment(slot, bytes);
    default:
      return { ok: false, detail: `Unknown upload kind "${slot.kind}".` };
  }
}
