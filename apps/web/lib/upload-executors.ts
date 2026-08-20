/**
 * Where uploaded bytes actually go. The /api/upload route authenticates and
 * claims a slot, then hands the bytes here; each executor forwards them to
 * the slot's destination UNDER THE REQUESTING USER'S OWN STORED GRANTS —
 * the same resolution the MCP transport uses, so an upload can do nothing
 * its requester's tools could not.
 *
 * Every upstream call is bounded (jiraFetch/confluence/graph carry the
 * fetch-guard timeouts; upload-session chunks carry their own).
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import {
  ATLASSIAN,
  ATLASSIAN_JSM,
  getGrant,
  readAtlassianMetadata,
} from '@renkei/provider-grants';
import { graphUploadViaSession } from '@renkei/connector-microsoft';
import { cacheTokenMetadata, jiraFetch } from '@/lib/mcp-tools/common';
import {
  graphPost,
  graphPutContent,
  resolveGraphAccess,
  str,
  rec,
} from '@/lib/mcp-tools/graph/client';
import {
  confluenceUpload,
  resolveConfluenceAccess,
} from '@/lib/mcp-tools/confluence/client';
import type { MCPToolContext } from '@/lib/mcp-tools/common';

/** Graph's simple-PUT ceiling for drive items; past it → upload session. */
const DRIVE_SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
/** Graph's inline fileAttachment ceiling for messages; past it → session. */
const MESSAGE_ATTACHMENT_INLINE_MAX = 3 * 1024 * 1024;

export interface UploadSlotRow {
  id: string;
  tenant_id: string;
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
 * The Atlassian gateway token + cloud id for a slot: the JSM grant when the
 * kind wants it and the user connected one, otherwise the main Jira grant.
 * cacheTokenMetadata arms jiraFetch's 401-refresh path, same as the MCP
 * transport does per request.
 */
async function resolveAtlassian(
  db: Kysely<DB>,
  slot: UploadSlotRow,
  preferJsm: boolean
): Promise<{ accessToken: string; cloudId: string } | string> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return 'Token encryption is not configured on this deployment.';

  const candidates: { provider: string; accountId: string }[] = [];
  if (preferJsm) {
    const jsmRow = await db
      .selectFrom('provider_grants')
      .select('provider_account_id')
      .where('tenant_id', '=', slot.tenant_id)
      .where('provider', '=', ATLASSIAN_JSM)
      .where('subject', '=', slot.subject)
      .limit(1)
      .executeTakeFirst();
    if (jsmRow) candidates.push({ provider: ATLASSIAN_JSM, accountId: jsmRow.provider_account_id });
  }
  candidates.push({ provider: ATLASSIAN, accountId: slot.account_id });

  for (const candidate of candidates) {
    const grantResult = await getGrant(
      candidate.provider,
      slot.tenant_id,
      candidate.accountId,
      keyResult.val
    );
    if (!grantResult.ok || !grantResult.val) continue;
    const grant = grantResult.val;
    const site = readAtlassianMetadata(grant.metadata);
    if (!site.cloudId) continue;
    cacheTokenMetadata(grant.accessToken, slot.tenant_id, grant.accountId, slot.subject);
    return { accessToken: grant.accessToken, cloudId: site.cloudId };
  }
  return 'No usable Atlassian grant for this upload — reconnect Jira and request a new endpoint.';
}

function graphContextOf(slot: UploadSlotRow): { tenantId: string; subject: string } {
  return { tenantId: slot.tenant_id, subject: slot.subject };
}

async function jiraAttachment(db: Kysely<DB>, slot: UploadSlotRow, bytes: Buffer): Promise<UploadOutcome> {
  const issueKey = str(destinationOf(slot).issueKey);
  if (!issueKey) return { ok: false, detail: 'The upload slot carries no issue key.' };
  const access = await resolveAtlassian(db, slot, false);
  if (typeof access === 'string') return { ok: false, detail: access };

  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(bytes)]), slot.filename);
  try {
    const response = await jiraFetch(
      `https://api.atlassian.com/ex/jira/${access.cloudId}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`,
      access.accessToken,
      { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, body: formData }
    );
    await response.text().catch(() => '');
    return { ok: true, detail: `Attached "${slot.filename}" to ${issueKey}.` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function jsmAttachment(db: Kysely<DB>, slot: UploadSlotRow, bytes: Buffer): Promise<UploadOutcome> {
  const requestKey = str(destinationOf(slot).requestKey);
  if (!requestKey) return { ok: false, detail: 'The upload slot carries no request key.' };
  const access = await resolveAtlassian(db, slot, true);
  if (typeof access === 'string') return { ok: false, detail: access };
  const base = `https://api.atlassian.com/ex/jira/${access.cloudId}`;

  try {
    // The servicedeskapi flow is two-legged: multipart to the SERVICE DESK's
    // attachTemporaryFile, then attach the returned temporary ids to the
    // request as JSON (ported from the retired jsm_add_request_attachment).
    const reqResponse = await jiraFetch(
      `${base}/rest/servicedeskapi/request/${encodeURIComponent(requestKey)}`,
      access.accessToken
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
      access.accessToken,
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
      access.accessToken,
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
      access.accessToken,
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
    access.accessToken,
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
      access.accessToken,
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
    access.accessToken,
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

export async function executeUpload(
  db: Kysely<DB>,
  slot: UploadSlotRow,
  bytes: Buffer
): Promise<UploadOutcome> {
  switch (slot.kind) {
    case 'jira-attachment':
      return jiraAttachment(db, slot, bytes);
    case 'jsm-attachment':
      return jsmAttachment(db, slot, bytes);
    case 'confluence-attachment':
      return confluenceAttachment(slot, bytes);
    case 'onedrive-document':
    case 'sharepoint-document':
      return driveDocument(slot, bytes);
    case 'outlook-draft-attachment':
      return outlookDraftAttachment(slot, bytes);
    default:
      return { ok: false, detail: `Unknown upload kind "${slot.kind}".` };
  }
}
