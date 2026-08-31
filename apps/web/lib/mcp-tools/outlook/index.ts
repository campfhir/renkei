/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Outlook (Microsoft Graph) MCP tools over the caller's own delegated grant
 * ("Renkei reads my mailbox as me"). Every call runs with that user's
 * token, so the tools see exactly what the user can see — nothing more.
 *
 * Mostly reads — list/get/search mail, calendar view, To Do tasks, the
 * employee directory — plus three acting tools the user asked Renkei to be
 * able to take: send a mail, create a calendar event (which sends the
 * invites), and respond to an invite (accept / tentative / decline /
 * propose a new time). The acting tools carry readOnlyHint false, so org
 * read-only mode disables them.
 *
 * Auth is injected (see ../graph/graph-auth.ts's GraphAuth) rather than
 * resolved inline — production passes the caller's own Microsoft grant,
 * shared with the SharePoint/OneDrive tools since all three close over the
 * same context (see registry.ts). auth.resolve() is called fresh on every
 * tool invocation rather than once at registration: tokens rotate on
 * refresh, handlers are cached, and a stale closure was exactly the failure
 * mode the Jira tools solved with a token-cache layer. Tool volume here is
 * low enough to resolve fresh per call.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  GRAPH_BASE_URL,
  buildMailQueryPath,
  clientSideSelect,
  graphBatch,
  hasClientSideFilter,
  matchesClientSide,
  objectIdOfMicrosoftRefId,
  withCategoryChanges,
  type MailSearchFilters,
} from '@renkei/connector-microsoft';
import { actMeta } from '@renkei/tool-outcomes';
import { resolveEmbeddingProvider, searchKnowledge } from '@renkei/knowledge';
import { withheldNote } from '@renkei/gates';
import { logger, secure } from '@/lib/logger';
import { withScopeGate } from '../capability-gate';
import { buildKnowledgeVerifiers } from '../knowledge';
import { withPresentationHint, type MCPToolContext } from '../common';
import {
  APP_ONLY_META,
  EMAIL_COMPOSE_URI,
  ISSUE_PREVIEW_URI,
  confirmGuard,
  previewToolMeta,
  newPreviewId,
} from '../widgets';
import type { GraphAuth } from '../graph/graph-auth';
import {
  DIRECTORY_SEARCH_HEADERS,
  DIRECTORY_USER_SELECT,
  searchDirectoryUsers,
} from '../graph/directory';
import { REQUEST_TIMEOUT_MS, isTimeoutError, timeoutSignal } from '../fetch-guard';
import { registerBulkJobTools } from './bulk-jobs';
import { createUploadSlot } from '../upload-slots';
import { extractText } from '@renkei/document-text';

export const OUTLOOK_MCP_CONNECTOR = 'microsoft';

function describeStatus(status: number, responseBody = ''): string {
  const detail = graphErrorDetail(responseBody);
  const suffix = detail ? ` — ${detail}` : '';
  if (status === 403) {
    return (
      'Graph refused (403) — the grant likely lacks the needed scope, or the Entra app is ' +
      'missing the delegated permission. Reconnect Microsoft after the admin fixes the app.' +
      suffix
    );
  }
  if (status === 429) return `Graph is rate limiting (429); try again shortly.${suffix}`;
  return `Microsoft Graph answered ${status}${suffix}`;
}

/**
 * Graph's own account of what was wrong, pulled out of the error body.
 *
 * Without this a rejected query reads only "Microsoft Graph answered 400",
 * which is what a caller sees and what gets reported — the body went to the
 * log, where nobody triaging from the chat side can reach it. Diagnosing the
 * InefficientFilter bug this shipped alongside took a session of bisecting
 * parameters that Graph would have named outright.
 *
 * Only the code and message are taken. `innerError` carries request ids and
 * timestamps that say nothing to the person reading, and the message itself
 * is Microsoft's fixed prose about the QUERY, not mailbox content — nothing
 * from a message body reaches here.
 */
function graphErrorDetail(responseBody: string): string {
  if (!responseBody) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return '';
  }
  const error = rec(rec(parsed).error);
  const code = str(error.code);
  const message = str(error.message);
  if (!code && !message) return '';
  const detail = code && message ? `${code}: ${message}` : code || message;
  // Bounded: Graph is terse here, but a caller's reply should never be
  // dominated by an error string.
  return detail.length > 400 ? `${detail.slice(0, 400)}…` : detail;
}

/** Cap a logged body: enough to diagnose, bounded against megabyte payloads. */
function truncateForLog(text: string): string {
  return text.length > 1300 ? `${text.slice(0, 1300)}… (${text.length} chars total)` : text;
}

async function graphGet(
  context: MCPToolContext,
  accessToken: string,
  pathAndQuery: string,
  extraHeaders?: Record<string, string>
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch(`${GRAPH_BASE_URL}${pathAndQuery}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Prefer: 'outlook.body-content-type="text"',
        ...extraHeaders,
      },
      signal: timeoutSignal(undefined, REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = isTimeoutError(error);
    logger.warn('Graph API unreachable', {
      component: 'outlook/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
      timedOut,
    });
    return {
      ok: false,
      error: timedOut
        ? `graph.microsoft.com timed out after ${REQUEST_TIMEOUT_MS}ms`
        : 'Could not reach graph.microsoft.com',
    };
  }
  const responseBody = await response.text().catch(() => '');
  if (!response.ok) {
    logger.warn('Graph API non-OK response', {
      component: 'outlook/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
      status: response.status,
      responseBody: responseBody ? secure(truncateForLog(responseBody)) : undefined,
    });
    return { ok: false, error: describeStatus(response.status, responseBody) };
  }
  let body: unknown = null;
  try {
    body = JSON.parse(responseBody);
  } catch {
    // fall through to the malformed check
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Malformed Graph API response' };
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { ok: true, body: body as Record<string, unknown> };
}

/** POST to Graph; 202/204 answers have no body, JSON answers are parsed. */
async function graphPost(
  context: MCPToolContext,
  accessToken: string,
  pathAndQuery: string,
  json: unknown
): Promise<{ ok: true; body: Record<string, unknown> | null } | { ok: false; error: string }> {
  let response: Response;
  const requestBody = JSON.stringify(json);
  try {
    response = await fetch(`${GRAPH_BASE_URL}${pathAndQuery}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: requestBody,
      signal: timeoutSignal(undefined, REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = isTimeoutError(error);
    logger.warn('Graph API unreachable', {
      component: 'outlook/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
      timedOut,
    });
    return {
      ok: false,
      error: timedOut
        ? `graph.microsoft.com timed out after ${REQUEST_TIMEOUT_MS}ms`
        : 'Could not reach graph.microsoft.com',
    };
  }
  const responseBody = await response.text().catch(() => '');
  if (!response.ok) {
    logger.warn('Graph API non-OK response', {
      component: 'outlook/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
      method: 'POST',
      status: response.status,
      requestBody: secure(truncateForLog(requestBody)),
      responseBody: responseBody ? secure(truncateForLog(responseBody)) : undefined,
    });
    return { ok: false, error: describeStatus(response.status, responseBody) };
  }
  let body: unknown = null;
  try {
    body = JSON.parse(responseBody);
  } catch {
    // 202 Accepted / 204 No Content — success with nothing to parse.
  }
  return {
    ok: true,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    body: typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null,
  };
}

/** PATCH to Graph; used to add recipients to a reply/forward draft before sending it. */
async function graphPatch(
  context: MCPToolContext,
  accessToken: string,
  pathAndQuery: string,
  json: unknown
): Promise<{ ok: true } | { ok: false; error: string }> {
  const requestBody = JSON.stringify(json);
  let response: Response;
  try {
    response = await fetch(`${GRAPH_BASE_URL}${pathAndQuery}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: requestBody,
      signal: timeoutSignal(undefined, REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = isTimeoutError(error);
    logger.warn('Graph API unreachable', {
      component: 'outlook/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
      timedOut,
    });
    return {
      ok: false,
      error: timedOut
        ? `graph.microsoft.com timed out after ${REQUEST_TIMEOUT_MS}ms`
        : 'Could not reach graph.microsoft.com',
    };
  }
  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    logger.warn('Graph API non-OK response', {
      component: 'outlook/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
      method: 'PATCH',
      status: response.status,
      requestBody: secure(truncateForLog(requestBody)),
      responseBody: responseBody ? secure(truncateForLog(responseBody)) : undefined,
    });
    return { ok: false, error: describeStatus(response.status, responseBody) };
  }
  return { ok: true };
}

/** DELETE a Graph resource — used only as best-effort cleanup of an orphaned draft. */
async function graphDelete(
  context: MCPToolContext,
  accessToken: string,
  pathAndQuery: string
): Promise<void> {
  try {
    const response = await fetch(`${GRAPH_BASE_URL}${pathAndQuery}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: timeoutSignal(undefined, REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn('Could not clean up an orphaned draft', {
        component: 'outlook/fetch',
        tenantId: context.tenantId,
        subject: context.subject,
        path: pathAndQuery,
        status: response.status,
      });
    }
  } catch {
    // Best-effort only — the draft is left in the mailbox's Drafts folder.
  }
}

/**
 * DELETE a Graph resource and report success/failure — unlike `graphDelete`
 * above (best-effort orphaned-draft cleanup, failures only logged), an
 * intentional delete like removing a mail folder must surface a failure to
 * the caller rather than swallow it.
 */
async function graphDeleteChecked(
  context: MCPToolContext,
  accessToken: string,
  pathAndQuery: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch(`${GRAPH_BASE_URL}${pathAndQuery}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: timeoutSignal(undefined, REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = isTimeoutError(error);
    logger.warn('Graph API unreachable', {
      component: 'outlook/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
      timedOut,
    });
    return {
      ok: false,
      error: timedOut
        ? `graph.microsoft.com timed out after ${REQUEST_TIMEOUT_MS}ms`
        : 'Could not reach graph.microsoft.com',
    };
  }
  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    logger.warn('Graph API non-OK response', {
      component: 'outlook/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
      method: 'DELETE',
      status: response.status,
      responseBody: responseBody ? secure(truncateForLog(responseBody)) : undefined,
    });
    return { ok: false, error: describeStatus(response.status, responseBody) };
  }
  return { ok: true };
}

function values(body: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(body.value)
    ? body.value.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null
      )
    : [];
}

function textResult(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function rec(value: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function senderOf(message: Record<string, unknown>): string {
  const address = rec(rec(message.from).emailAddress);
  return str(address.name) || str(address.address) || '(unknown sender)';
}

/**
 * The GROUPING key: address only, lowercased. Anything involving the
 * display name is a bad key — automated senders routinely vary it per
 * message ("Jira (PROJ-1)", "Jira (PROJ-2)") while the address stays
 * constant, and collapsing exactly that is the point of sender grouping.
 */
function senderKeyOf(message: Record<string, unknown>): string {
  const address = rec(rec(message.from).emailAddress);
  return (str(address.address) || str(address.name) || '(unknown sender)').toLowerCase();
}

/** The human-readable label for a group — name plus address when both exist. */
function senderLabelOf(message: Record<string, unknown>): string {
  const address = rec(rec(message.from).emailAddress);
  const email = str(address.address);
  const name = str(address.name);
  if (!email) return name || '(unknown sender)';
  return name ? `${name} <${email}>` : email;
}

/**
 * Content types whose bytes are worth decoding straight to text for the
 * model, rather than handing back base64 it can do nothing with.
 * Deliberately a allow-list of formats that are genuinely plain text —
 * PDF/DOCX/XLSX are binary container formats that would decode to noise,
 * so they're reported as binary instead of pretending to extract them.
 */
function isTextualContentType(contentType: string): boolean {
  const type = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (type.startsWith('text/')) return true;
  if (type.endsWith('+json') || type.endsWith('+xml')) return true;
  return [
    'application/json',
    'application/xml',
    'application/csv',
    'application/javascript',
    'application/x-yaml',
    'application/yaml',
    'application/sql',
    'application/x-sh',
  ].includes(type);
}

/** Decoded-text ceiling per attachment — matches outlook_get_message's body cap. */
const ATTACHMENT_TEXT_MAX_CHARS = 60_000;
/**
 * Formats the model can be shown as-is: PDFs (page-rendered by the
 * provider from a document block) and the raster images vision models
 * accept. Everything else binary goes through text extraction only.
 */
const RENDERABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/**
 * Ceiling on bytes attached as a viewable document/image. These bytes ride
 * the MCP transport once and become typed content the provider decodes —
 * never text tokens — but page-rendering is priced per page, so huge files
 * still fall back to extracted text alone.
 */
const ATTACHMENT_DOCUMENT_MAX_BYTES = 10_000_000;

/** Human byte size, mirroring graph/client's — this module predates it. */
function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function attachmentKindOf(attachment: Record<string, unknown>): string {
  const odataType = str(attachment['@odata.type']);
  if (odataType.includes('itemAttachment')) return 'item';
  if (odataType.includes('referenceAttachment')) return 'reference';
  return 'file';
}

function attachmentLine(attachment: Record<string, unknown>): string {
  const size = typeof attachment.size === 'number' ? attachment.size : 0;
  const kind = attachmentKindOf(attachment);
  return (
    `${str(attachment.name) || '(unnamed)'} — ${str(attachment.contentType) || 'unknown type'}` +
    ` — ${size} bytes` +
    (kind !== 'file' ? ` — ${kind} attachment` : '') +
    (attachment.isInline === true ? ' — inline' : '') +
    ` — id: ${str(attachment.id)}`
  );
}

/**
 * How many 100-message pages a client-side subject scan may pull before
 * giving up and handing the caller a pageToken to continue from. Bounded
 * because a rare substring against a 24k-message mailbox would otherwise
 * walk the entire thing in one tool call.
 */
const SUBJECT_SCAN_PAGE_BUDGET = 10;
/** Same idea for countOnly, which has to walk rows to build a sender breakdown. */
const COUNT_SCAN_PAGE_BUDGET = 10;

function messageLine(message: Record<string, unknown>): string {
  const unread = message.isRead === false;
  return (
    `[${str(message.receivedDateTime)}]${unread ? ' (unread)' : ''} ${senderOf(message)} — ` +
    `${str(message.subject) || '(no subject)'} — id: ${str(message.id)}\n  ` +
    `${str(message.bodyPreview).replace(/\n/g, '\n  ')}`
  );
}

/**
 * outlook_bulk_search_messages's line: no body preview (these results feed
 * bulk actions, not reading), but shows read/flag/category state since
 * that's usually exactly what the caller filtered on.
 */
function bulkSearchLine(message: Record<string, unknown>): string {
  const flagStatus = str(rec(message.flag).flagStatus) || 'notFlagged';
  const categories = Array.isArray(message.categories)
    ? message.categories.filter((category): category is string => typeof category === 'string')
    : [];
  return (
    `${message.isRead === false ? '(unread) ' : ''}${str(message.subject) || '(no subject)'} — ` +
    `${senderOf(message)} — ${str(message.receivedDateTime)}` +
    (flagStatus !== 'notFlagged' ? ` — flag: ${flagStatus}` : '') +
    (categories.length > 0 ? ` — categories: ${categories.join(', ')}` : '') +
    ` — id: ${str(message.id)}`
  );
}

function recipientOf(address: string): { emailAddress: { address: string } } {
  return { emailAddress: { address } };
}

function addressesOf(entries: unknown): string[] {
  return Array.isArray(entries)
    ? entries.map((entry) => str(rec(rec(entry).emailAddress).address)).filter(Boolean)
    : [];
}

/** `base` (Graph's auto-populated recipients, if any) plus `extra`, address de-duplicated. */
function unionAddresses(base: readonly string[], extra: readonly string[]): string[] {
  const seen = new Set(base.map((address) => address.toLowerCase()));
  const merged = [...base];
  for (const address of extra) {
    const key = address.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(address);
    }
  }
  return merged;
}

/**
 * Reply / reply-all / forward all follow the same shape once recipients can
 * be edited: Graph's one-shot `/reply`, `/replyAll`, `/forward` actions only
 * take a comment (and, for forward, a fixed `toRecipients`) — there is no
 * way to also add a cc/bcc or extra "to" in that single call. The
 * `createX` + PATCH + `send` sequence creates a real draft first, so
 * recipients can be edited before it goes out. `additionalTo`/`cc`/`bcc`
 * are unioned onto whatever Graph auto-populated (the original sender for
 * reply, sender + all recipients for reply-all, nothing for forward — so
 * "union with nothing" is exactly "use what was given").
 */
/** What a created (not yet sent) draft looks like to a caller or a preview card. */
interface DraftInfo {
  ok: true;
  draftId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** Graph's plain-text bodyPreview — the comment atop the quoted thread. */
  bodyPreview: string;
  /**
   * Outlook-on-the-web link to the message, taken straight from Graph.
   *
   * A draft KEEPS its id when it is sent — the message moves to Sent Items
   * rather than being recreated — so the link captured here still resolves
   * afterwards, and it is the only moment a link is available at all:
   * `/send` answers 202 with an empty body. This is what puts an "open it"
   * on the notification for a reply.
   */
  webLink: string;
}

async function createDraftAction(
  context: MCPToolContext,
  accessToken: string,
  messageId: string,
  action: 'createReply' | 'createReplyAll' | 'createForward',
  options: {
    comment?: string;
    additionalTo: readonly string[];
    cc: readonly string[];
    bcc: readonly string[];
  }
): Promise<DraftInfo | { ok: false; error: string }> {
  const created = await graphPost(
    context,
    accessToken,
    `/me/messages/${encodeURIComponent(messageId)}/${action}`,
    options.comment ? { comment: options.comment } : {}
  );
  if (!created.ok) return created;
  const draft = created.body ?? {};
  const draftId = str(draft.id);
  if (!draftId) return { ok: false, error: 'Graph did not return a draft id' };

  const toRecipients = unionAddresses(addressesOf(draft.toRecipients), options.additionalTo);
  const ccRecipients = unionAddresses(addressesOf(draft.ccRecipients), options.cc);
  const bccRecipients = unionAddresses(addressesOf(draft.bccRecipients), options.bcc);
  const needsPatch =
    options.additionalTo.length > 0 || options.cc.length > 0 || options.bcc.length > 0;
  if (needsPatch) {
    if (toRecipients.length === 0) {
      // Forward auto-populates nothing, so this only fires for a forward
      // whose caller-supplied "to" turned out empty — reply/reply-all always
      // have Graph's own auto-populated sender/all to fall back to.
      await graphDelete(context, accessToken, `/me/messages/${encodeURIComponent(draftId)}`);
      return { ok: false, error: 'No recipient to send to' };
    }
    const patched = await graphPatch(
      context,
      accessToken,
      `/me/messages/${encodeURIComponent(draftId)}`,
      {
        toRecipients: toRecipients.map(recipientOf),
        ...(ccRecipients.length > 0 ? { ccRecipients: ccRecipients.map(recipientOf) } : {}),
        ...(bccRecipients.length > 0 ? { bccRecipients: bccRecipients.map(recipientOf) } : {}),
      }
    );
    if (!patched.ok) {
      await graphDelete(context, accessToken, `/me/messages/${encodeURIComponent(draftId)}`);
      return patched;
    }
  }

  return {
    ok: true,
    draftId,
    to: toRecipients,
    cc: ccRecipients,
    bcc: bccRecipients,
    subject: str(draft.subject),
    bodyPreview: str(draft.bodyPreview),
    webLink: str(draft.webLink),
  };
}

/** Send an existing draft. `keepOnFailure` leaves it in Drafts for a retry. */
async function sendDraft(
  context: MCPToolContext,
  accessToken: string,
  draftId: string,
  keepOnFailure = false
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sent = await graphPost(
    context,
    accessToken,
    `/me/messages/${encodeURIComponent(draftId)}/send`,
    {}
  );
  if (!sent.ok && !keepOnFailure) {
    await graphDelete(context, accessToken, `/me/messages/${encodeURIComponent(draftId)}`);
  }
  return sent.ok ? { ok: true } : sent;
}

async function sendDraftAction(
  context: MCPToolContext,
  accessToken: string,
  messageId: string,
  action: 'createReply' | 'createReplyAll' | 'createForward',
  options: {
    comment?: string;
    additionalTo: readonly string[];
    cc: readonly string[];
    bcc: readonly string[];
  }
): Promise<{ ok: true; webLink: string; subject: string } | { ok: false; error: string }> {
  const created = await createDraftAction(context, accessToken, messageId, action, options);
  if (!created.ok) return created;
  const sent = await sendDraft(context, accessToken, created.draftId);
  if (!sent.ok) return sent;
  return { ok: true, webLink: created.webLink, subject: created.subject };
}

/**
 * The receipt for a message that has just gone out, so its notification can
 * name it and link to it.
 *
 * The SUBJECT is the identifier, not the message id. A person says "the one
 * about the invoice"; nobody has ever read a Graph message id aloud, and a
 * notification reading "Sent an email AAMkAGI2…" is worse than one that
 * just says "Sent an email". Quoted so it reads as a title rather than as
 * the rest of the sentence.
 */
function sentMailMeta(sent: { webLink: string; subject: string }): Record<string, unknown> {
  return actMeta({
    ...(sent.subject ? { id: `“${sent.subject}”` } : {}),
    ...(sent.webLink ? { url: sent.webLink } : {}),
  });
}

function eventLine(event: Record<string, unknown>): string {
  const start = rec(event.start);
  const end = rec(event.end);
  const organizer = rec(rec(event.organizer).emailAddress);
  return (
    `${str(event.subject) || '(no subject)'} — ${str(start.dateTime)} → ${str(end.dateTime)}` +
    ` — organizer: ${str(organizer.name) || str(organizer.address) || '(unknown)'}` +
    (str(rec(event.location).displayName) ? ` — ${str(rec(event.location).displayName)}` : '') +
    ` — id: ${str(event.id)}`
  );
}

/** Which Graph scope each tool stands on; registration filters against the grant. */
export function outlookScopeFor(toolName: string): string[] {
  switch (toolName) {
    case 'outlook_list_events':
    case 'outlook_get_event':
    case 'outlook_find_meeting_times':
      return ['Calendars.Read'];
    case 'outlook_list_task_lists':
    case 'outlook_list_tasks':
      return ['Tasks.Read'];
    // The preview/confirm pairs stand on the same scope as the sends they
    // gate: a grant that may send may also preview, and vice versa.
    case 'outlook_send_mail':
    case 'outlook_reply_message':
    case 'outlook_reply_all_message':
    case 'outlook_forward_message':
    case 'outlook_send_mail_preview':
    case 'outlook_reply_preview':
    case 'outlook_reply_all_preview':
    case 'outlook_forward_preview':
    case 'outlook_send_draft_confirm':
    case 'outlook_discard_draft_confirm':
    case 'outlook_request_draft_attachment_upload':
      return ['Mail.Send'];
    // The bulk-job pair shares one scope so it appears and disappears
    // together — a status tool without its submit tool (or vice versa) is
    // just noise, the same reasoning as the preview/confirm pairs above.
    case 'outlook_mark_message':
    case 'outlook_flag_message':
    case 'outlook_categorize_message':
    case 'outlook_move_message':
    case 'outlook_start_bulk_mail_job':
    case 'outlook_get_bulk_mail_job':
      return ['Mail.ReadWrite'];
    case 'outlook_create_mail_folder':
    case 'outlook_rename_mail_folder':
    case 'outlook_delete_mail_folder':
      return ['MailboxFolder.ReadWrite'];
    case 'outlook_create_event':
    case 'outlook_respond_event':
    case 'outlook_cancel_event_preview':
    case 'outlook_cancel_event_confirm':
      return ['Calendars.ReadWrite'];
    case 'outlook_search_users':
    case 'outlook_get_user':
      return ['User.Read.All'];
    case 'outlook_list_groups':
    case 'outlook_list_group_members':
      return ['Group.Read.All'];
    default:
      // list/get/search message tools
      return ['Mail.Read'];
  }
}

// The directory query, its required header and its $select live in
// ../graph/directory.ts — the people picker in the builder needs the same
// three and they are each a silent-failure waiting to drift.
const USER_SELECT = DIRECTORY_USER_SELECT;

function userLine(user: Record<string, unknown>): string {
  const phones = [
    ...(Array.isArray(user.businessPhones)
      ? user.businessPhones.filter((phone): phone is string => typeof phone === 'string')
      : []),
    ...(str(user.mobilePhone) ? [str(user.mobilePhone)] : []),
  ].join(', ');
  return [
    str(user.displayName) || '(no name)',
    str(user.jobTitle),
    str(user.department),
    str(user.officeLocation),
    str(user.mail) || str(user.userPrincipalName),
    phones,
  ]
    .filter(Boolean)
    .join(' — ');
}

function groupKind(group: Record<string, unknown>): string {
  const groupTypes = Array.isArray(group.groupTypes) ? group.groupTypes : [];
  if (groupTypes.includes('Unified')) return 'Microsoft 365 group';
  if (group.mailEnabled === true && group.securityEnabled === true) {
    return 'mail-enabled security group';
  }
  if (group.mailEnabled === true) return 'distribution list';
  return 'security group';
}

export async function registerOutlookTools(
  rawServer: McpServer,
  context: MCPToolContext,
  auth: GraphAuth
): Promise<void> {
  // A tool whose scope this user's grant does not carry is not registered at
  // all — the org may have narrowed the checkboxes, or the user narrowed
  // their own connect.
  const server = withScopeGate(rawServer, context.graphScopes, (name) => outlookScopeFor(name));

  // The async bulk mail job pair (replacing the synchronous outlook_bulk_*
  // act tools) lives in its own module — this file is long enough.
  registerBulkJobTools(server, context, auth);

  // outlook_request_draft_attachment_upload — files reach a composed email
  // via an out-of-band endpoint, never as model-generated base64.
  server.registerTool(
    'outlook_request_draft_attachment_upload',
    {
      title: 'Outlook · Act — Request an upload endpoint for a draft attachment',
      description:
        'Attach a NEW file to an email draft (the draftId from ' +
        'outlook_send_mail_preview/reply/forward previews) — without base64. Returns a ' +
        'short-lived single-use endpoint; send the raw bytes there (curl with the ' +
        'Authorization header, or the returned browser link). Never generate file content ' +
        'as a tool argument.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        draftId: z.string().min(1).describe('Draft message id from a compose preview'),
        filename: z.string().min(1).describe('File name for the attachment'),
        contentType: z.string().describe('MIME type (optional)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const draftId = str(args.draftId);
      const filename = str(args.filename);
      if (!draftId || !filename) return errText('draftId and filename are required');

      const slot = await createUploadSlot(
        context,
        'outlook-draft-attachment',
        { draftId },
        { filename, contentType: str(args.contentType) || undefined }
      );
      if (!slot.ok) return errText(slot.error);
      return textResult(slot.instructions);
    }
  );

  server.registerTool(
    'outlook_list_mail_folders',
    {
      title: 'Outlook · Read — List mail folders',
      description:
        'The connected user’s mail folder tree — id, display name, unread/total item counts. ' +
        'Folder ids feed outlook_list_messages and outlook_move_message. Well-known folders ' +
        '(inbox, archive, deleteditems, drafts, sentitems, junkemail) can also be used by name ' +
        'directly without listing first.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        parentFolderId: z
          .string()
          .describe('List this folder’s children instead of the top-level tree')
          .optional(),
        max: z.number().int().min(1).max(200).describe('How many (default 50)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const max = typeof args.max === 'number' ? args.max : 50;
      const parentFolderId = str(args.parentFolderId);
      const path = parentFolderId
        ? `/me/mailFolders/${encodeURIComponent(parentFolderId)}/childFolders`
        : '/me/mailFolders';
      const result = await graphGet(
        context,
        access.accessToken,
        `${path}?$top=${max}&$select=id,displayName,unreadItemCount,totalItemCount,childFolderCount`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map((folder) => {
        const unread = typeof folder.unreadItemCount === 'number' ? folder.unreadItemCount : 0;
        const total = typeof folder.totalItemCount === 'number' ? folder.totalItemCount : 0;
        const children = typeof folder.childFolderCount === 'number' ? folder.childFolderCount : 0;
        return (
          `${str(folder.displayName) || '(unnamed)'} — ${unread} unread / ${total} total` +
          (children > 0 ? ` — ${children} subfolder(s)` : '') +
          ` — id: ${str(folder.id)}`
        );
      });
      if (lines.length === 0) return textResult('No folders.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'an indented tree (matching the folder hierarchy) usually reads clearer than a flat ' +
            'list once there are several subfolders.'
        )
      );
    }
  );

  server.registerTool(
    'outlook_list_messages',
    {
      title: 'Outlook · Read — List Outlook messages',
      description:
        'List recent messages in a mail folder (default: inbox), newest first, with previews. ' +
        'Message ids feed outlook_get_message.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        folder: z
          .string()
          .describe('Well-known folder name or folder id (default "inbox")')
          .optional(),
        max: z.number().int().min(1).max(50).describe('How many (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const folder = str(args.folder) || 'inbox';
      const max = typeof args.max === 'number' ? args.max : 20;
      const query =
        `/me/mailFolders/${encodeURIComponent(folder)}/messages` +
        `?$top=${max}&$orderby=receivedDateTime desc` +
        `&$select=id,subject,from,receivedDateTime,bodyPreview,isRead`;
      const result = await graphGet(context, access.accessToken, query);
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(messageLine);
      if (lines.length === 0) return textResult('No messages.');
      return textResult(
        withPresentationHint(
          lines.join('\n\n'),
          'a table (From, Subject, Received, Read) usually scans faster than this flat list, ' +
            'especially with more than a handful of results.'
        )
      );
    }
  );

  server.registerTool(
    'outlook_get_message',
    {
      title: 'Outlook · Read — Get one Outlook message',
      description: 'Fetch a single message by id, with its full body as text.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        messageId: z.string().min(1).describe('Message id from outlook_list_messages'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const messageId = str(args.messageId);
      if (!messageId) return errText('messageId is required');
      const result = await graphGet(
        context,
        access.accessToken,
        `/me/messages/${encodeURIComponent(messageId)}` +
          `?$select=id,subject,from,toRecipients,receivedDateTime,body,isRead,flag,categories`
      );
      if (!result.ok) return errText(result.error);
      const message = result.body;
      const to = Array.isArray(message.toRecipients)
        ? message.toRecipients
            .map((entry) => str(rec(rec(entry).emailAddress).address))
            .filter(Boolean)
            .join(', ')
        : '';
      const bodyText = str(rec(message.body).content);
      // A long thread can be a lot of text; cap what one tool call returns.
      const MAX = 60_000;
      const capped =
        bodyText.length > MAX
          ? `${bodyText.slice(0, MAX)}\n\n[…truncated: ${bodyText.length - MAX} more characters]`
          : bodyText;
      const flagStatus = str(rec(message.flag).flagStatus) || 'notFlagged';
      const categories = Array.isArray(message.categories)
        ? message.categories.filter((c): c is string => typeof c === 'string')
        : [];
      return textResult(
        `Subject: ${str(message.subject) || '(no subject)'}\n` +
          `From: ${senderOf(message)}\nTo: ${to}\nReceived: ${str(message.receivedDateTime)}\n` +
          `Read: ${message.isRead === false ? 'No' : 'Yes'}` +
          (flagStatus !== 'notFlagged' ? `\nFlag: ${flagStatus}` : '') +
          (categories.length > 0 ? `\nCategories: ${categories.join(', ')}` : '') +
          '\n\n' +
          capped
      );
    }
  );

  server.registerTool(
    'outlook_list_attachments',
    {
      title: 'Outlook · Read — List a message’s attachments',
      description:
        'List the files attached to ONE message (many: use outlook_bulk_list_attachments) — ' +
        'name, type, size, and the attachment id that ' +
        'feeds outlook_get_attachment. Inline images (embedded signature logos and the like) are ' +
        'hidden by default since they are almost never what someone means by "the attachment"; ' +
        'pass includeInline to see them. Note a message can carry inline images while ' +
        'hasAttachments is false, so an empty result here is meaningful but a false ' +
        'hasAttachments is not.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        messageId: z
          .string()
          .min(1)
          .describe('Message id from outlook_list_messages/outlook_bulk_search_messages'),
        includeInline: z
          .boolean()
          .describe('Include inline/embedded images (default false)')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const messageId = str(args.messageId);
      if (!messageId) return errText('messageId is required');

      const result = await graphGet(
        context,
        access.accessToken,
        `/me/messages/${encodeURIComponent(messageId)}/attachments` +
          `?$select=id,name,contentType,size,isInline`
      );
      if (!result.ok) return errText(result.error);
      const all = values(result.body);
      const attachments =
        args.includeInline === true ? all : all.filter((entry) => entry.isInline !== true);
      if (attachments.length === 0) {
        return textResult(
          all.length > 0
            ? `No attachments (${all.length} inline image(s) hidden — pass includeInline to see them).`
            : 'No attachments.'
        );
      }
      return textResult(
        withPresentationHint(
          attachments.map(attachmentLine).join('\n'),
          'a table (Name, Type, Size, id) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'outlook_get_attachment',
    {
      title: 'Outlook · Read — Download one attachment',
      description:
        'Fetch an attachment’s content. Plain-text formats (txt, csv, json, xml, yaml, source ' +
        'code) are decoded and returned as readable text. PDF, Word and Excel files are ' +
        'TEXT-EXTRACTED server-side and returned as readable text; PDFs and images are ' +
        'additionally attached as viewable documents where the client supports it, so the ' +
        'pages themselves (tables, charts, layout) can be looked at. Base64 is never ' +
        'returned as text.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        messageId: z.string().min(1).describe('Message id the attachment belongs to'),
        attachmentId: z.string().min(1).describe('Attachment id from outlook_list_attachments'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const messageId = str(args.messageId);
      if (!messageId) return errText('messageId is required');
      const attachmentId = str(args.attachmentId);
      if (!attachmentId) return errText('attachmentId is required');

      const basePath =
        `/me/messages/${encodeURIComponent(messageId)}` +
        `/attachments/${encodeURIComponent(attachmentId)}`;
      const result = await graphGet(context, access.accessToken, basePath);
      if (!result.ok) return errText(result.error);
      const attachment = result.body;
      const name = str(attachment.name) || '(unnamed)';
      const contentType = str(attachment.contentType) || 'application/octet-stream';
      const size = typeof attachment.size === 'number' ? attachment.size : 0;
      const kind = attachmentKindOf(attachment);

      // A reference attachment is a link to a cloud file — there are no
      // bytes to fetch here at all.
      if (kind === 'reference') {
        return textResult(
          `"${name}" is a link to a cloud file, not an attached copy — there are no bytes to ` +
            `download through this tool.` +
            (str(attachment.sourceUrl) ? `\nLink: ${str(attachment.sourceUrl)}` : '')
        );
      }

      // An item attachment is an embedded message/event/contact. Re-fetch
      // with the expand Graph requires to see the item itself.
      if (kind === 'item') {
        const expanded = await graphGet(
          context,
          access.accessToken,
          `${basePath}?$expand=microsoft.graph.itemattachment/item`
        );
        const item = expanded.ok ? rec(rec(expanded.body).item) : {};
        const bodyText = str(rec(item.body).content);
        return textResult(
          `"${name}" is an embedded item (a forwarded message, event, or contact), not a file.\n` +
            (str(item.subject) ? `Subject: ${str(item.subject)}\n` : '') +
            (str(rec(rec(item.from).emailAddress).address)
              ? `From: ${str(rec(rec(item.from).emailAddress).address)}\n`
              : '') +
            (bodyText ? `\n${bodyText.slice(0, ATTACHMENT_TEXT_MAX_CHARS)}` : '')
        );
      }

      const contentBytes = str(attachment.contentBytes);
      if (!contentBytes) {
        return errText(`Graph returned no content for "${name}" (${size} bytes, ${contentType}).`);
      }

      if (isTextualContentType(contentType)) {
        const decoded = Buffer.from(contentBytes, 'base64').toString('utf8');
        const capped =
          decoded.length > ATTACHMENT_TEXT_MAX_CHARS
            ? `${decoded.slice(0, ATTACHMENT_TEXT_MAX_CHARS)}\n\n[…truncated: ${decoded.length - ATTACHMENT_TEXT_MAX_CHARS} more characters]`
            : decoded;
        return textResult(`${name} (${contentType}, ${size} bytes):\n\n${capped}`);
      }

      // Binary formats: NEVER base64-as-text — the model cannot decode it
      // and it burns ~1 token per 2-3 characters saying nothing. Instead:
      // text is EXTRACTED server-side (the same pipeline the document read
      // tools use), and formats a model can look at (PDF pages, images)
      // additionally ride the result's _meta as typed blocks the agent
      // engine feeds to the model as actual pages. MCP clients that ignore
      // _meta still get the extracted text.
      const mediaType = contentType.split(';')[0].trim().toLowerCase();
      const bytes = Buffer.from(contentBytes, 'base64');
      const visual =
        mediaType === 'application/pdf' || RENDERABLE_IMAGE_TYPES.has(mediaType)
          ? bytes.byteLength <= ATTACHMENT_DOCUMENT_MAX_BYTES
          : false;
      const meta = visual
        ? { renkeiDocuments: [{ mediaType, dataBase64: contentBytes, title: name }] }
        : undefined;

      if (RENDERABLE_IMAGE_TYPES.has(mediaType)) {
        // Images carry no text to extract; MCP has a first-class image
        // content type vision clients render for the model directly.
        return {
          content: [
            { type: 'text' as const, text: `${name} (${mediaType}, ${byteSize(size)}), attached:` },
            ...(visual
              ? [{ type: 'image' as const, data: contentBytes, mimeType: mediaType }]
              : []),
          ],
          ...(meta ? { _meta: meta } : {}),
        };
      }

      const extracted = await extractText(bytes, { fileName: name, contentType: mediaType });
      if (!extracted.ok) {
        const because: Record<string, string> = {
          UNSUPPORTED_FORMAT: 'its format cannot be read as text',
          ENCRYPTED: 'it is password protected',
          CORRUPT: 'the file appears to be damaged',
          EMPTY: 'it contains no text',
          INPUT_TOO_LARGE: 'it is too large to parse here',
          EXTRACTION_FAILED: 'the text could not be extracted',
        };
        const reason = because[extracted.err.type] ?? 'unknown reason';
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Cannot read "${name}" (${mediaType}, ${byteSize(size)}) — ${reason}.` +
                (meta ? ' The document itself is attached for direct viewing.' : ''),
            },
          ],
          ...(meta ? { _meta: meta } : { isError: true as const }),
        };
      }

      const text = extracted.val.text;
      const capped =
        text.length > ATTACHMENT_TEXT_MAX_CHARS
          ? `${text.slice(0, ATTACHMENT_TEXT_MAX_CHARS)}\n\n[…truncated: ${text.length - ATTACHMENT_TEXT_MAX_CHARS} more characters]`
          : text;
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${name} (${mediaType}, ${byteSize(size)}), extracted text` +
              `${meta ? ' (the document itself is also attached)' : ''}:\n\n${capped}`,
          },
        ],
        ...(meta ? { _meta: meta } : {}),
      };
    }
  );

  server.registerTool(
    'outlook_bulk_list_attachments',
    {
      title: 'Outlook · Read — List attachments across many messages',
      description:
        'List attachment metadata for up to 200 messages in one batched call — pair with ' +
        'outlook_bulk_search_messages(hasAttachments: true) to survey what is attached across a ' +
        'whole set of mail without one call per message. Returns names/types/sizes/ids; use ' +
        'outlook_get_attachment to pull any individual file’s content.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        messageIds: z
          .array(z.string().min(1))
          .min(1)
          .max(200)
          .describe('Message ids, e.g. from outlook_bulk_search_messages'),
        includeInline: z
          .boolean()
          .describe('Include inline/embedded images (default false)')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const messageIds = Array.isArray(args.messageIds)
        ? args.messageIds.map(String).filter(Boolean)
        : [];
      if (messageIds.length === 0) return errText('messageIds is required');

      const batch = await graphBatch(
        access.accessToken,
        messageIds.map((id) => ({
          id,
          method: 'GET' as const,
          url:
            `/me/messages/${encodeURIComponent(id)}/attachments` +
            `?$select=id,name,contentType,size,isInline`,
        })),
        { lane: 'interactive' }
      );

      const sections: string[] = [];
      let totalAttachments = 0;
      const failures: string[] = [];
      for (const result of batch.results) {
        if (!result.ok) {
          failures.push(`  • ${result.id}: ${result.error ?? 'unknown error'}`);
          continue;
        }
        const all = values(result.body ?? {});
        const attachments =
          args.includeInline === true ? all : all.filter((entry) => entry.isInline !== true);
        if (attachments.length === 0) continue;
        totalAttachments += attachments.length;
        sections.push(
          `message ${result.id} (${attachments.length}):\n` +
            attachments.map((entry) => `    ${attachmentLine(entry)}`).join('\n')
        );
      }

      if (sections.length === 0) {
        return textResult(
          `No attachments across ${messageIds.length} message(s).` +
            (failures.length > 0 ? `\n\nFailed to read:\n${failures.join('\n')}` : '')
        );
      }
      const footer =
        `\n\n${totalAttachments} attachment(s) across ${sections.length} of ` +
        `${messageIds.length} message(s).` +
        (failures.length > 0 ? `\n\nFailed to read:\n${failures.join('\n')}` : '');
      return textResult(
        withPresentationHint(
          sections.join('\n\n') + footer,
          'a table (Message, Attachment, Type, Size, id) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'outlook_search_messages',
    {
      title: 'Outlook · Read — Search Outlook messages',
      description:
        'Full-text search across the connected mailbox ($search): subjects, bodies, senders.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().min(1).describe('Search terms, e.g. "quarterly report from:dana"'),
        max: z.number().int().min(1).max(50).describe('How many (default 20)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const query = str(args.query);
      if (!query) return errText('query is required');
      const max = typeof args.max === 'number' ? args.max : 20;
      const result = await graphGet(
        context,
        access.accessToken,
        `/me/messages?$search=${encodeURIComponent(`"${query.replace(/"/g, '')}"`)}` +
          `&$top=${max}&$select=id,subject,from,receivedDateTime,bodyPreview,isRead`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(messageLine);
      if (lines.length === 0) return textResult('No matches.');
      return textResult(
        withPresentationHint(
          lines.join('\n\n'),
          'a table (From, Subject, Received, Read) usually scans faster than this flat list, ' +
            'especially with more than a handful of results.'
        )
      );
    }
  );

  server.registerTool(
    'outlook_bulk_search_messages',
    {
      title: 'Outlook · Read — Bulk search/filter messages (paged)',
      description:
        'Structured search across the mailbox (or one folder) — read/unread, flag status, ' +
        'categories, sender, subject substring, attachments, received-date range — with paging ' +
        'via pageToken. Built to feed outlook_start_bulk_mail_job: search here for the ' +
        'messages you mean, then submit their ids (or these same filters) as one async job. Two ' +
        'modes worth ' +
        'reaching for on a big cleanup: countOnly sizes a category (with a top-senders ' +
        'breakdown) before you commit, and groupBySender collapses a page into per-sender groups ' +
        'so automated noise is obvious without reading every subject line. For a freetext query ' +
        'instead of structured filters, use outlook_search_messages.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        folder: z
          .string()
          .describe('Well-known folder name or folder id (default: entire mailbox)')
          .optional(),
        isRead: z.boolean().describe('Only read (true) or unread (false) messages').optional(),
        flagStatus: z
          .enum(['flagged', 'complete', 'notFlagged'])
          .describe('Only messages with this flag status')
          .optional(),
        categories: z
          .array(z.string().min(1))
          .describe('Only messages carrying ALL of these categories')
          .optional(),
        hasAttachments: z
          .boolean()
          .describe('Only messages with (true) or without (false) attachments')
          .optional(),
        from: z.string().describe('Only messages from this exact sender address').optional(),
        to: z
          .string()
          .describe(
            'Only messages with this exact address on the To line. Applied after fetching — ' +
              'Exchange cannot filter recipient collections at all — so it scans several pages ' +
              'and reaches only as far back as the scan budget allows. Narrow it with folder ' +
              '(e.g. sentitems) or a received-date range for anything older.'
          )
          .optional(),
        cc: z
          .string()
          .describe(
            'Only messages with this exact address on the Cc line. Applied after ' +
              'fetching, exactly as `to`.'
          )
          .optional(),
        subjectContains: z
          .string()
          .describe(
            'Case-insensitive subject substring. Applied after fetching (Graph cannot filter ' +
              'mail subjects server-side), so it scans several pages to fill one page of matches.'
          )
          .optional(),
        receivedAfter: z
          .string()
          .describe('ISO-8601 — only messages received on/after this time')
          .optional(),
        receivedBefore: z
          .string()
          .describe('ISO-8601 — only messages received before this time')
          .optional(),
        countOnly: z
          .boolean()
          .describe(
            'Dry run: report how many messages match (and the top senders) without listing them ' +
              '— use this to size a cleanup before committing to it'
          )
          .optional(),
        groupBySender: z
          .boolean()
          .describe(
            'Group the results by sender with per-sender counts instead of listing each message ' +
              '— makes it far easier to spot automated/noise senders in a large unread pile'
          )
          .optional(),
        max: z
          .number()
          .int()
          .min(1)
          .max(100)
          .describe(
            'Page size (default 25). With subjectContains a page may come back slightly over ' +
              'this, because every match found while scanning is returned rather than dropped.'
          )
          .optional(),
        pageToken: z
          .string()
          .describe(
            'Continue from a previous call’s nextPageToken — ignores every other filter when set'
          )
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);

      const max = typeof args.max === 'number' ? args.max : 25;
      const countOnly = args.countOnly === true;
      const groupBySender = args.groupBySender === true;
      const pageToken = str(args.pageToken);

      // The clause builder is shared with the worker's mail bulk jobs —
      // filter shape, InefficientFilter-safe ordering, and the client-side
      // matcher all live in @renkei/connector-microsoft now.
      const searchFilters: MailSearchFilters = {
        folder: str(args.folder) || undefined,
        ...(typeof args.isRead === 'boolean' ? { isRead: args.isRead } : {}),
        flagStatus: str(args.flagStatus) || undefined,
        categories: Array.isArray(args.categories)
          ? args.categories.filter((c: unknown): c is string => typeof c === 'string' && !!c)
          : undefined,
        ...(typeof args.hasAttachments === 'boolean'
          ? { hasAttachments: args.hasAttachments }
          : {}),
        from: str(args.from) || undefined,
        to: str(args.to) || undefined,
        cc: str(args.cc) || undefined,
        subjectContains: str(args.subjectContains) || undefined,
        receivedAfter: str(args.receivedAfter) || undefined,
        receivedBefore: str(args.receivedBefore) || undefined,
      };
      // Anything Exchange cannot apply is applied after fetching, which is
      // what makes a page thin and the scan long.
      const scanning = hasClientSideFilter(searchFilters);
      const select = clientSideSelect(
        searchFilters,
        'id,subject,from,receivedDateTime,isRead,flag,categories'
      );
      const buildQuery = (top: number, withCount: boolean): string =>
        buildMailQueryPath(searchFilters, { top, withCount, select });

      // ---- dry run: a total, plus who it's from, without listing anything.
      if (countOnly) {
        // With no client-side filter Graph can answer the count itself in
        // one call ($count is supported on mail, unlike ConsistencyLevel,
        // which is a directory-objects-only feature and is deliberately not
        // sent). A sender breakdown still needs real rows, so scan for it.
        const senderCounts = new Map<string, { label: string; count: number }>();
        let scanned = 0;
        let matched = 0;
        let serverTotal: number | null = null;
        let next: string | null = buildQuery(100, true);
        for (let page = 0; page < COUNT_SCAN_PAGE_BUDGET && next; page += 1) {
          const result = await graphGet(context, access.accessToken, next);
          if (!result.ok) return errText(result.error);
          if (serverTotal === null && typeof result.body['@odata.count'] === 'number') {
            serverTotal = result.body['@odata.count'];
          }
          for (const message of values(result.body)) {
            scanned += 1;
            if (!matchesClientSide(message, searchFilters)) continue;
            matched += 1;
            const key = senderKeyOf(message);
            const existing = senderCounts.get(key);
            if (existing) existing.count += 1;
            else senderCounts.set(key, { label: senderLabelOf(message), count: 1 });
          }
          const nextLink = str(result.body['@odata.nextLink']);
          next = nextLink ? nextLink.replace(GRAPH_BASE_URL, '') : null;
        }

        const exhausted = next === null;
        const headline = scanning
          ? `${matched} match${matched === 1 ? '' : 'es'} among the ${scanned} message(s) scanned` +
            (exhausted ? '.' : ' so far (scan limit reached — there may be more).')
          : serverTotal !== null
            ? `${serverTotal} message(s) match.`
            : `${matched} message(s) match` + (exhausted ? '.' : ' so far (scan limit reached).');

        const topSenders = [...senderCounts.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 25)
          .map((entry) => `  ${entry.count} — ${entry.label}`);
        return textResult(
          topSenders.length > 0
            ? `${headline}\n\nTop senders${exhausted ? '' : ' (within the scanned pages)'}:\n${topSenders.join('\n')}`
            : headline
        );
      }

      // ---- listing mode.
      // A client-side filter can throw away most of a page, so keep pulling
      // pages until one page's worth of MATCHES is collected (or the scan
      // budget runs out). With nothing to match after fetching this is a
      // single call and the loop exits immediately.
      //
      // Every match in a page we fetched is kept, even once `max` is met, so
      // a scan can return a little more than the page size asked for. That
      // is deliberate and it is a bug fix: capping mid-page used to DISCARD
      // the rest of that page's matches and then hand back a pageToken
      // pointing at the page AFTER it, so those messages were unreachable by
      // any later call. Since `next` always advances a whole page, keeping
      // the whole page is what makes the continuation honest.
      const collected: Record<string, unknown>[] = [];
      let scanned = 0;
      let next: string | null = pageToken || buildQuery(scanning ? 100 : max, false);
      let pagesFetched = 0;
      const pageBudget = scanning ? SUBJECT_SCAN_PAGE_BUDGET : 1;

      while (next && collected.length < max && pagesFetched < pageBudget) {
        const result = await graphGet(context, access.accessToken, next);
        if (!result.ok) return errText(result.error);
        pagesFetched += 1;
        for (const message of values(result.body)) {
          scanned += 1;
          if (!matchesClientSide(message, searchFilters)) continue;
          collected.push(message);
        }
        const nextLink = str(result.body['@odata.nextLink']);
        next = nextLink ? nextLink.replace(GRAPH_BASE_URL, '') : null;
      }

      if (collected.length === 0) {
        return textResult(
          scanning
            ? `No messages match (scanned ${scanned}).` +
                (next ? ' Scan limit reached — pass pageToken to keep looking.' : '')
            : 'No messages match.'
        );
      }

      const footerParts = [`${collected.length} message(s)`];
      if (scanning) footerParts.push(`matched out of ${scanned} scanned`);
      footerParts.push(next ? `more available, pass pageToken: ${next}` : 'no more pages');
      const footer = `\n\n${footerParts.join(' — ')}`;

      if (groupBySender) {
        const bySender = new Map<string, { label: string; messages: Record<string, unknown>[] }>();
        for (const message of collected) {
          const key = senderKeyOf(message);
          const bucket = bySender.get(key);
          if (bucket) bucket.messages.push(message);
          else bySender.set(key, { label: senderLabelOf(message), messages: [message] });
        }
        const groups = [...bySender.values()]
          .sort((a, b) => b.messages.length - a.messages.length)
          .map((group) => {
            const subjects = group.messages
              .map(
                (message) =>
                  `    ${str(message.subject) || '(no subject)'} — id: ${str(message.id)}`
              )
              .join('\n');
            return `${group.label} (${group.messages.length}):\n${subjects}`;
          });
        return textResult(
          withPresentationHint(
            groups.join('\n\n') + footer,
            'grouping stays useful in the reply — a section per sender (or a table with a Sender ' +
              'column) makes automated senders obvious at a glance.'
          )
        );
      }

      return textResult(
        withPresentationHint(
          collected.map(bulkSearchLine).join('\n') + footer,
          'a table (Subject, From, Received, Read, Flag, Categories, id) usually scans faster ' +
            'than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'outlook_semantic_search_messages',
    {
      title: 'Outlook · Read — Find mail by meaning (semantic search)',
      description:
        'Search mail by MEANING rather than keywords — "the thread about renegotiating the ' +
        'vendor contract" finds messages that never use those words. Use this when you know ' +
        'roughly what a message was about but not what it literally said; use ' +
        'outlook_bulk_search_messages when you need exhaustive or structured results ' +
        '(unread, from a sender, a date range).\n\n' +
        'IMPORTANT: this searches Renkei’s INDEX of your mail, not the live mailbox — it only ' +
        'covers what has been ingested and embedded, so it can miss very recent or ' +
        'never-indexed mail and is not a substitute for a real mailbox query. Results carry ' +
        'message ids, so they feed outlook_start_bulk_mail_job directly.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().min(1).max(2000).describe('What the mail is about, in natural language'),
        max: z.number().int().min(1).max(25).describe('How many (default 10)').optional(),
        after: z.string().describe('Only mail received on/after this ISO-8601 time').optional(),
        before: z.string().describe('Only mail received before this ISO-8601 time').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const query = str(args.query);
      if (!query.trim()) return errText('query is required');
      const max = typeof args.max === 'number' ? args.max : 10;

      // Same gate as search_knowledge: with no recorded email nothing can be
      // verified at the source, so nothing is disclosed.
      const userEmail = context.userEmail;
      if (!userEmail) {
        return errText(
          'Renkei has no email on record for your identity, so access to indexed mail cannot be ' +
            'verified. Sign in to Renkei again to refresh it.'
        );
      }

      const embedder = await resolveEmbeddingProvider(context.tenantId);
      if (!embedder) {
        return errText(
          'Semantic search needs the knowledge layer, which is not configured for this ' +
            'organization. Use outlook_bulk_search_messages instead.'
        );
      }

      const verifiers = await buildKnowledgeVerifiers(context.tenantId);
      const searched = await searchKnowledge({
        tenantId: context.tenantId,
        userEmail,
        query,
        // Overfetch: several chunks of one long message collapse to a single
        // result below, so k results here can be far fewer messages.
        k: max * 3,
        embedder,
        verifiers,
        sources: [{ provider: 'microsoft', kind: 'msg' }],
        ...(str(args.after) ? { after: str(args.after) } : {}),
        ...(str(args.before) ? { before: str(args.before) } : {}),
      });
      if (!searched.ok) {
        return errText(
          searched.err.type === 'EMBEDDING_FAILED'
            ? 'The embedding provider could not process that query.'
            : 'The knowledge store could not be searched.'
        );
      }

      // Collapse chunks back to messages, keeping each message's closest
      // chunk — otherwise one long mail floods the whole result list.
      const byMessage = new Map<
        string,
        { messageId: string; subject: string; when: string | null; distance: number }
      >();
      for (const hit of searched.val.hits) {
        const objectId = objectIdOfMicrosoftRefId(hit.refId);
        if (!objectId) continue;
        // Strip the `#0001` chunk suffix so the id is usable as a message id.
        const messageId = objectId.split('#')[0] ?? objectId;
        const existing = byMessage.get(messageId);
        if (existing && existing.distance <= hit.distance) continue;
        byMessage.set(messageId, {
          messageId,
          subject: typeof hit.metadata.subject === 'string' ? hit.metadata.subject : '',
          when: hit.sourceAt,
          distance: hit.distance,
        });
      }

      const results = [...byMessage.values()].sort((a, b) => a.distance - b.distance).slice(0, max);
      // A refusal and a timeout both withhold, but only one of them means the
      // user lacks access; saying "no access" for a slow source would be a
      // false statement about their permissions.
      const withheld = withheldNote(searched.val.elided, searched.val.unverified);
      if (results.length === 0) {
        return textResult(
          withheld ? `No accessible matches.${withheld}` : 'No matches in the indexed mail.'
        );
      }

      const lines = results.map(
        (result) =>
          `${result.subject || '(no subject)'}` +
          (result.when ? ` — ${result.when}` : '') +
          ` — id: ${result.messageId}`
      );
      const footer = `\n\n${results.length} message(s), closest match first.${withheld}`;
      return textResult(
        withPresentationHint(
          lines.join('\n') + footer,
          'a table (Subject, Received, id) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'outlook_list_events',
    {
      title: 'Outlook · Read — List Outlook calendar events',
      description:
        'The connected user’s calendar in a time window (default: last 7 days through the next ' +
        '30), expanded from recurrences. Event ids feed outlook_get_event. When presenting the ' +
        'result, consider a calendar-like layout (a day-by-day agenda, or a small table of ' +
        'day/time/subject) rather than a flat list — usually easier to scan than plain text, ' +
        'especially across more than a few days.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        from: z.string().describe('ISO start of the window (default: 7 days ago)').optional(),
        to: z.string().describe('ISO end of the window (default: 30 days ahead)').optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const from = str(args.from) || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const to = str(args.to) || new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      const max = typeof args.max === 'number' ? args.max : 25;
      const result = await graphGet(
        context,
        access.accessToken,
        `/me/calendarView?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}` +
          `&$top=${max}&$orderby=start/dateTime` +
          `&$select=id,subject,start,end,organizer,location`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(eventLine);
      if (lines.length === 0) return textResult('No events in that window.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'this reads better to a person as a calendar layout — a day-by-day agenda, or a table ' +
            'of day/time/subject — than as this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'outlook_get_event',
    {
      title: 'Outlook · Read — Get one Outlook calendar event',
      description: 'Fetch a single event by id, with attendees and its body as text.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        eventId: z.string().min(1).describe('Event id from outlook_list_events'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const eventId = str(args.eventId);
      if (!eventId) return errText('eventId is required');
      const result = await graphGet(
        context,
        access.accessToken,
        `/me/events/${encodeURIComponent(eventId)}` +
          `?$select=id,subject,start,end,organizer,location,attendees,body,webLink`
      );
      if (!result.ok) return errText(result.error);
      const event = result.body;
      const attendees = Array.isArray(event.attendees)
        ? event.attendees
            .map((entry) => str(rec(rec(entry).emailAddress).address))
            .filter(Boolean)
            .join(', ')
        : '';
      return textResult(
        `${eventLine(event)}\nAttendees: ${attendees || '(none listed)'}\n\n` +
          str(rec(event.body).content).slice(0, 20_000)
      );
    }
  );

  server.registerTool(
    'outlook_list_task_lists',
    {
      title: 'Outlook · Read — List Microsoft To Do lists',
      description: 'The connected user’s To Do task lists. List ids feed outlook_list_tasks.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const result = await graphGet(context, access.accessToken, '/me/todo/lists');
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(
        (list) => `${str(list.displayName) || '(unnamed)'} — id: ${str(list.id)}`
      );
      return textResult(lines.length === 0 ? 'No task lists.' : lines.join('\n'));
    }
  );

  server.registerTool(
    'outlook_list_tasks',
    {
      title: 'Outlook · Read — List Microsoft To Do tasks',
      description: 'Tasks in one To Do list, optionally filtered by status.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        listId: z.string().min(1).describe('List id from outlook_list_task_lists'),
        status: z
          .enum(['notStarted', 'inProgress', 'completed'])
          .describe('Only tasks with this status')
          .optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const listId = str(args.listId);
      if (!listId) return errText('listId is required');
      const max = typeof args.max === 'number' ? args.max : 25;
      const status = str(args.status);
      const filter = status ? `&$filter=status eq '${status}'` : '';
      const result = await graphGet(
        context,
        access.accessToken,
        `/me/todo/lists/${encodeURIComponent(listId)}/tasks?$top=${max}${filter}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map((task) => {
        const due = str(rec(task.dueDateTime).dateTime);
        return (
          `[${str(task.status)}] ${str(task.title) || '(untitled)'}` +
          (due ? ` — due ${due}` : '') +
          ` — id: ${str(task.id)}`
        );
      });
      if (lines.length === 0) return textResult('No tasks.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a checklist grouped by status (or sorted by due date) usually reads clearer than this ' +
            'flat list.'
        )
      );
    }
  );

  server.registerTool(
    'outlook_search_users',
    {
      title: 'Outlook · Read — Search the employee directory',
      description:
        'Search the organization directory by name or email: title, department, location, ' +
        'email, phone. Ids/UPNs feed outlook_get_user for manager and direct reports.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().min(1).describe('Name or email fragment, e.g. "dana" or "dana@corp"'),
        max: z.number().int().min(1).max(50).describe('How many (default 15)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      if (!str(args.query).replace(/"/g, '').trim()) return errText('query is required');
      const max = typeof args.max === 'number' ? args.max : 15;
      const found = await searchDirectoryUsers(context, access.accessToken, str(args.query), max);
      if (typeof found === 'string') return errText(found);
      const lines = found.map((user) => `${userLine(user)} — id: ${str(user.id)}`);
      if (lines.length === 0) return textResult('No directory matches.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Name, Title, Department, Email) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'outlook_get_user',
    {
      title: 'Outlook · Read — Get one directory entry',
      description:
        'One person from the organization directory, with their manager and direct reports — ' +
        'the org-chart view around them.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        user: z.string().min(1).describe('User id or UPN/email from outlook_search_users'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const user = str(args.user);
      if (!user) return errText('user is required');
      const encoded = encodeURIComponent(user);

      const profile = await graphGet(
        context,
        access.accessToken,
        `/users/${encoded}?${USER_SELECT}`
      );
      if (!profile.ok) return errText(profile.error);

      // Manager and reports are separate calls; either may legitimately be
      // empty (the CEO, a leaf IC) — absence is an answer, not an error.
      const [manager, reports] = await Promise.all([
        graphGet(context, access.accessToken, `/users/${encoded}/manager?${USER_SELECT}`),
        graphGet(context, access.accessToken, `/users/${encoded}/directReports?${USER_SELECT}`),
      ]);

      const lines = [userLine(profile.body)];
      lines.push('', manager.ok ? `Manager: ${userLine(manager.body)}` : 'Manager: (none listed)');
      const reportLines = reports.ok ? values(reports.body).map(userLine) : [];
      lines.push(
        '',
        reportLines.length > 0
          ? `Direct reports (${reportLines.length}):\n${reportLines.map((line) => `  • ${line}`).join('\n')}`
          : 'Direct reports: (none)'
      );
      const body = lines.join('\n');
      return textResult(
        reportLines.length > 3
          ? withPresentationHint(
              body,
              'a small org-chart layout (manager above, direct reports below) usually reads ' +
                'clearer than this flat list once there are several reports.'
            )
          : body
      );
    }
  );

  server.registerTool(
    'outlook_list_groups',
    {
      title: 'Outlook · Read — List groups & mailing lists',
      description:
        'Microsoft 365 groups, distribution lists and security groups in the organization, ' +
        'with their email addresses. Group ids feed outlook_list_group_members.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        query: z.string().describe('Narrow by name fragment').optional(),
        mailingListsOnly: z
          .boolean()
          .describe('Only mail-enabled groups (default false)')
          .optional(),
        max: z.number().int().min(1).max(100).describe('How many (default 25)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const max = typeof args.max === 'number' ? args.max : 25;
      const parts = [
        `$top=${max}`,
        '$count=true',
        '$select=id,displayName,mail,description,groupTypes,mailEnabled,securityEnabled',
      ];
      const query = str(args.query).replace(/"/g, '');
      if (query) parts.push(`$search=${encodeURIComponent(`"displayName:${query}"`)}`);
      if (args.mailingListsOnly === true) parts.push('$filter=mailEnabled eq true');
      const result = await graphGet(
        context,
        access.accessToken,
        `/groups?${parts.join('&')}`,
        DIRECTORY_SEARCH_HEADERS
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(
        (group) =>
          `${str(group.displayName) || '(unnamed)'} — ${groupKind(group)}` +
          (str(group.mail) ? ` — ${str(group.mail)}` : '') +
          (str(group.description) ? ` — ${str(group.description).slice(0, 120)}` : '') +
          ` — id: ${str(group.id)}`
      );
      if (lines.length === 0) return textResult('No groups.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Name, Type, Email) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'outlook_list_group_members',
    {
      title: 'Outlook · Read — List members of a group',
      description: 'Who is in a group or on a mailing list, with titles and emails.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        groupId: z.string().min(1).describe('Group id from outlook_list_groups'),
        max: z.number().int().min(1).max(200).describe('How many (default 50)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const groupId = str(args.groupId);
      if (!groupId) return errText('groupId is required');
      const max = typeof args.max === 'number' ? args.max : 50;
      const result = await graphGet(
        context,
        access.accessToken,
        `/groups/${encodeURIComponent(groupId)}/members?$top=${max}&${USER_SELECT}`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(userLine);
      if (lines.length === 0) return textResult('No members.');
      return textResult(
        withPresentationHint(
          lines.join('\n'),
          'a table (Name, Title, Email) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'outlook_send_mail',
    {
      title: 'Outlook · Act — Send an email',
      description:
        'Send an email as the connected user — e.g. a summary assembled with the other tools. ' +
        'Plain text body. This speaks AS the user, so only send what they asked to send.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        to: z.array(z.string().min(1)).min(1).describe('Recipient email addresses'),
        cc: z.array(z.string().min(1)).describe('CC email addresses').optional(),
        subject: z.string().min(1).describe('Subject line'),
        body: z.string().min(1).describe('Body, plain text'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const to = Array.isArray(args.to) ? args.to.map(String).filter(Boolean) : [];
      if (to.length === 0) return errText('to is required');
      const cc = Array.isArray(args.cc) ? args.cc.map(String).filter(Boolean) : [];
      const recipient = (address: string) => ({ emailAddress: { address } });

      const result = await graphPost(context, access.accessToken, '/me/sendMail', {
        message: {
          subject: str(args.subject),
          body: { contentType: 'Text', content: str(args.body) },
          toRecipients: to.map(recipient),
          ...(cc.length > 0 ? { ccRecipients: cc.map(recipient) } : {}),
        },
        saveToSentItems: true,
      });
      if (!result.ok) return errText(result.error);
      logger.info('outlook_send_mail sent', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        recipients: to.length + cc.length,
      });
      /*
        The subject, and NO link — the one send in this file that cannot
        offer one.

        `/me/sendMail` answers 202 with an empty body, so there is no id to
        link to. Drafting first (POST /me/messages, then /send) WOULD yield
        a webLink, and it is tempting because reply/reply-all/forward
        already work that way — but creating a message resource needs
        Mail.ReadWrite, and this tool stands on Mail.Send alone (see
        `outlookScopeFor`, and `MICROSOFT_SCOPE_OPTIONS`, where
        Mail.ReadWrite is off by default and warns that anyone already
        connected must reconnect to gain it). Buying a link with a 403 for
        every default grant is not a trade worth making.

        Hunting Sent Items for the message afterwards is the other tempting
        option and is worse: sendMail is asynchronous, so the match is
        racy, and a notification linking to somebody else's email is the
        exact failure this module refuses to risk.

        The subject still goes in, because it is not inferred from anything
        — it is what the caller asked to send. "Sent an email" alone tells
        you nothing; "Sent an email “Q3 invoice follow-up”" tells you what
        happened even without somewhere to click.
      */
      return {
        ...textResult(`Sent to ${[...to, ...cc].join(', ')}.`),
        _meta: sentMailMeta({ webLink: '', subject: str(args.subject) }),
      };
    }
  );

  server.registerTool(
    'outlook_reply_message',
    {
      title: 'Outlook · Act — Reply to an email',
      description:
        'Reply to the sender of a message the connected user received. Graph auto-populates ' +
        'the sender as recipient and handles subject/threading/quoting — additionalTo/cc/bcc ' +
        'add more people beyond that if the user asked for it. Only send what they asked to send.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        messageId: z
          .string()
          .min(1)
          .describe('Message id from outlook_list_messages/outlook_get_message'),
        comment: z.string().min(1).describe('Reply body, plain text'),
        additionalTo: z
          .array(z.string().min(1))
          .describe('Extra "to" addresses beyond the original sender')
          .optional(),
        cc: z.array(z.string().min(1)).describe('CC addresses to add').optional(),
        bcc: z.array(z.string().min(1)).describe('BCC addresses to add').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const messageId = str(args.messageId);
      if (!messageId) return errText('messageId is required');
      const comment = str(args.comment);
      if (!comment) return errText('comment is required');
      const additionalTo = Array.isArray(args.additionalTo)
        ? args.additionalTo.map(String).filter(Boolean)
        : [];
      const cc = Array.isArray(args.cc) ? args.cc.map(String).filter(Boolean) : [];
      const bcc = Array.isArray(args.bcc) ? args.bcc.map(String).filter(Boolean) : [];

      const result = await sendDraftAction(context, access.accessToken, messageId, 'createReply', {
        comment,
        additionalTo,
        cc,
        bcc,
      });
      if (!result.ok) return errText(result.error);
      logger.info('outlook_reply_message sent', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        messageId,
      });
      return {
        ...textResult(
          'Reply sent.' +
            (additionalTo.length > 0 ? ` Also to: ${additionalTo.join(', ')}.` : '') +
            (cc.length > 0 ? ` Cc: ${cc.join(', ')}.` : '') +
            (bcc.length > 0 ? ` Bcc: ${bcc.join(', ')}.` : '')
        ),
        _meta: sentMailMeta(result),
      };
    }
  );

  server.registerTool(
    'outlook_reply_all_message',
    {
      title: 'Outlook · Act — Reply all to an email',
      description:
        'Reply to everyone on a message the connected user received (sender and all other ' +
        'recipients). Graph auto-populates that full set and handles subject/threading/quoting ' +
        '— additionalTo/cc/bcc add more people beyond that if the user asked for it. Only send ' +
        'what they asked to send.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        messageId: z
          .string()
          .min(1)
          .describe('Message id from outlook_list_messages/outlook_get_message'),
        comment: z.string().min(1).describe('Reply body, plain text'),
        additionalTo: z
          .array(z.string().min(1))
          .describe('Extra "to" addresses beyond the original sender/recipients')
          .optional(),
        cc: z.array(z.string().min(1)).describe('CC addresses to add').optional(),
        bcc: z.array(z.string().min(1)).describe('BCC addresses to add').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const messageId = str(args.messageId);
      if (!messageId) return errText('messageId is required');
      const comment = str(args.comment);
      if (!comment) return errText('comment is required');
      const additionalTo = Array.isArray(args.additionalTo)
        ? args.additionalTo.map(String).filter(Boolean)
        : [];
      const cc = Array.isArray(args.cc) ? args.cc.map(String).filter(Boolean) : [];
      const bcc = Array.isArray(args.bcc) ? args.bcc.map(String).filter(Boolean) : [];

      const result = await sendDraftAction(
        context,
        access.accessToken,
        messageId,
        'createReplyAll',
        {
          comment,
          additionalTo,
          cc,
          bcc,
        }
      );
      if (!result.ok) return errText(result.error);
      logger.info('outlook_reply_all_message sent', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        messageId,
      });
      return {
        ...textResult(
          'Reply-all sent.' +
            (additionalTo.length > 0 ? ` Also to: ${additionalTo.join(', ')}.` : '') +
            (cc.length > 0 ? ` Cc: ${cc.join(', ')}.` : '') +
            (bcc.length > 0 ? ` Bcc: ${bcc.join(', ')}.` : '')
        ),
        _meta: sentMailMeta(result),
      };
    }
  );

  server.registerTool(
    'outlook_forward_message',
    {
      title: 'Outlook · Act — Forward an email',
      description:
        'Forward a message the connected user received to new recipients, with an optional ' +
        'note. Unlike reply, Graph auto-populates no recipients for a forward — "to" is ' +
        'required. Only send what they asked to send.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        messageId: z
          .string()
          .min(1)
          .describe('Message id from outlook_list_messages/outlook_get_message'),
        to: z.array(z.string().min(1)).min(1).describe('Recipient email addresses'),
        comment: z.string().describe('Note prepended above the forwarded message').optional(),
        cc: z.array(z.string().min(1)).describe('CC addresses').optional(),
        bcc: z.array(z.string().min(1)).describe('BCC addresses').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const messageId = str(args.messageId);
      if (!messageId) return errText('messageId is required');
      const to = Array.isArray(args.to) ? args.to.map(String).filter(Boolean) : [];
      if (to.length === 0) return errText('to is required');
      const cc = Array.isArray(args.cc) ? args.cc.map(String).filter(Boolean) : [];
      const bcc = Array.isArray(args.bcc) ? args.bcc.map(String).filter(Boolean) : [];

      const result = await sendDraftAction(
        context,
        access.accessToken,
        messageId,
        'createForward',
        {
          comment: str(args.comment) || undefined,
          additionalTo: to,
          cc,
          bcc,
        }
      );
      if (!result.ok) return errText(result.error);
      logger.info('outlook_forward_message sent', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        messageId,
      });
      return {
        ...textResult(
          `Forwarded to ${to.join(', ')}.` +
            (cc.length > 0 ? ` Cc: ${cc.join(', ')}.` : '') +
            (bcc.length > 0 ? ` Bcc: ${bcc.join(', ')}.` : '')
        ),
        _meta: sentMailMeta(result),
      };
    }
  );

  // ——— Interactive previews (MCP Apps) ————————————————————————————————
  // Each preview tool creates a REAL Graph draft and binds its result to the
  // email card (ui://widget/email-compose.html): the user sees exactly what
  // Graph will send and the card's buttons run the app-only confirm tools
  // below. On a host without MCP Apps support the draft still exists — the
  // text result says so, and the user can send it from Outlook's Drafts.

  const previewResultText = (draft: DraftInfo, what: string) =>
    `${what} is drafted and awaiting the user's decision on the preview card — ` +
    `to: ${draft.to.join(', ') || '(auto-populated)'}; subject: ${draft.subject || '(none)'}. ` +
    `Do not send it another way and do not repeat the draft contents in your reply; the user ` +
    `sends or discards from the card. If no card appeared in this client, tell the user the ` +
    `draft is in their Outlook Drafts folder.`;

  const draftStructured = (kind: string, draft: DraftInfo, body: string) => ({
    kind,
    draftId: draft.draftId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body,
  });

  server.registerTool(
    'outlook_send_mail_preview',
    {
      title: 'Outlook · Act — Preview an email before sending',
      description:
        'Draft an email and show the user an interactive preview card to send or discard. ' +
        'Prefer this over outlook_send_mail whenever the user should review before it goes ' +
        'out — the card does the sending. Plain text body. This speaks AS the user.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(EMAIL_COMPOSE_URI),
      inputSchema: z.object({
        to: z.array(z.string().min(1)).min(1).describe('Recipient email addresses'),
        cc: z.array(z.string().min(1)).describe('CC email addresses').optional(),
        bcc: z.array(z.string().min(1)).describe('BCC email addresses').optional(),
        subject: z.string().min(1).describe('Subject line'),
        body: z.string().min(1).describe('Body, plain text'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const to = Array.isArray(args.to) ? args.to.map(String).filter(Boolean) : [];
      if (to.length === 0) return errText('to is required');
      const cc = Array.isArray(args.cc) ? args.cc.map(String).filter(Boolean) : [];
      const bcc = Array.isArray(args.bcc) ? args.bcc.map(String).filter(Boolean) : [];
      const subject = str(args.subject);
      const body = str(args.body);

      const created = await graphPost(context, access.accessToken, '/me/messages', {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: to.map(recipientOf),
        ...(cc.length > 0 ? { ccRecipients: cc.map(recipientOf) } : {}),
        ...(bcc.length > 0 ? { bccRecipients: bcc.map(recipientOf) } : {}),
      });
      if (!created.ok) return errText(created.error);
      const draftId = str((created.body ?? {}).id);
      if (!draftId) return errText('Graph did not return a draft id');

      logger.info('outlook_send_mail_preview drafted', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        recipients: to.length + cc.length + bcc.length,
      });
      const draft: DraftInfo = {
        ok: true,
        draftId,
        to,
        cc,
        bcc,
        subject,
        bodyPreview: body,
        webLink: str((created.body ?? {}).webLink),
      };
      return {
        ...textResult(previewResultText(draft, 'The email')),
        structuredContent: draftStructured('compose', draft, body),
      };
    }
  );

  // The three reply-family previews share their shape with the direct tools
  // above — same inputs, same draft pipeline — but stop before the send.
  const replyPreviews = [
    {
      name: 'outlook_reply_preview',
      kind: 'reply',
      action: 'createReply' as const,
      title: 'Outlook · Act — Preview a reply before sending',
      what: 'The reply',
      description:
        'Draft a reply to a message and show the user an interactive preview card to send or ' +
        'discard. Prefer this over outlook_reply_message whenever the user should review ' +
        'first. Graph auto-populates the sender as recipient and handles threading/quoting.',
    },
    {
      name: 'outlook_reply_all_preview',
      kind: 'replyAll',
      action: 'createReplyAll' as const,
      title: 'Outlook · Act — Preview a reply-all before sending',
      what: 'The reply-all',
      description:
        'Draft a reply to everyone on a message and show the user an interactive preview card ' +
        'to send or discard. Prefer this over outlook_reply_all_message whenever the user ' +
        'should review first.',
    },
  ];
  for (const preview of replyPreviews) {
    server.registerTool(
      preview.name,
      {
        title: preview.title,
        description: preview.description,
        annotations: { readOnlyHint: false },
        _meta: previewToolMeta(EMAIL_COMPOSE_URI),
        inputSchema: z.object({
          messageId: z
            .string()
            .min(1)
            .describe('Message id from outlook_list_messages/outlook_get_message'),
          comment: z.string().min(1).describe('Reply body, plain text'),
          additionalTo: z
            .array(z.string().min(1))
            .describe('Extra "to" addresses beyond the auto-populated recipients')
            .optional(),
          cc: z.array(z.string().min(1)).describe('CC addresses to add').optional(),
          bcc: z.array(z.string().min(1)).describe('BCC addresses to add').optional(),
        }),
      },
      async (args: Record<string, any>) => {
        const access = await auth.resolve();
        if (typeof access === 'string') return errText(access);
        const messageId = str(args.messageId);
        if (!messageId) return errText('messageId is required');
        const comment = str(args.comment);
        if (!comment) return errText('comment is required');

        const created = await createDraftAction(
          context,
          access.accessToken,
          messageId,
          preview.action,
          {
            comment,
            additionalTo: Array.isArray(args.additionalTo)
              ? args.additionalTo.map(String).filter(Boolean)
              : [],
            cc: Array.isArray(args.cc) ? args.cc.map(String).filter(Boolean) : [],
            bcc: Array.isArray(args.bcc) ? args.bcc.map(String).filter(Boolean) : [],
          }
        );
        if (!created.ok) return errText(created.error);
        logger.info(`${preview.name} drafted`, {
          component: 'mcp/tool',
          tenantId: context.tenantId,
          messageId,
        });
        return {
          ...textResult(previewResultText(created, preview.what)),
          structuredContent: draftStructured(preview.kind, created, created.bodyPreview),
        };
      }
    );
  }

  server.registerTool(
    'outlook_forward_preview',
    {
      title: 'Outlook · Act — Preview a forward before sending',
      description:
        'Draft a forward of a message and show the user an interactive preview card to send ' +
        'or discard. Prefer this over outlook_forward_message whenever the user should ' +
        'review first. Unlike reply, "to" is required — Graph auto-populates no recipients.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(EMAIL_COMPOSE_URI),
      inputSchema: z.object({
        messageId: z
          .string()
          .min(1)
          .describe('Message id from outlook_list_messages/outlook_get_message'),
        to: z.array(z.string().min(1)).min(1).describe('Recipient email addresses'),
        comment: z.string().describe('Note prepended above the forwarded message').optional(),
        cc: z.array(z.string().min(1)).describe('CC addresses').optional(),
        bcc: z.array(z.string().min(1)).describe('BCC addresses').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const messageId = str(args.messageId);
      if (!messageId) return errText('messageId is required');
      const to = Array.isArray(args.to) ? args.to.map(String).filter(Boolean) : [];
      if (to.length === 0) return errText('to is required');

      const created = await createDraftAction(
        context,
        access.accessToken,
        messageId,
        'createForward',
        {
          comment: str(args.comment) || undefined,
          additionalTo: to,
          cc: Array.isArray(args.cc) ? args.cc.map(String).filter(Boolean) : [],
          bcc: Array.isArray(args.bcc) ? args.bcc.map(String).filter(Boolean) : [],
        }
      );
      if (!created.ok) return errText(created.error);
      logger.info('outlook_forward_preview drafted', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        messageId,
      });
      return {
        ...textResult(previewResultText(created, 'The forward')),
        structuredContent: draftStructured('forward', created, created.bodyPreview),
      };
    }
  );

  server.registerTool(
    'outlook_send_draft_confirm',
    {
      title: 'Outlook · Act — Send a previewed draft (card only)',
      description:
        'Send an email draft created by an outlook preview tool.' +
        confirmGuard('outlook_send_mail_preview (or a reply/forward preview)'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: z.object({
        draftId: z.string().min(1).describe('Draft id from a preview tool'),
        overrides: z
          .object({
            to: z.array(z.string().min(1)).optional(),
            cc: z.array(z.string().min(1)).optional(),
            subject: z.string().optional(),
            body: z.string().describe('Body, plain text').optional(),
          })
          .describe('Edits the user made on the card, PATCHed onto the draft before sending')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const draftId = str(args.draftId);
      if (!draftId) return errText('draftId is required');

      const overrides = rec(args.overrides);
      const to = Array.isArray(overrides.to) ? overrides.to.map(String).filter(Boolean) : null;
      const cc = Array.isArray(overrides.cc) ? overrides.cc.map(String).filter(Boolean) : null;
      if (to !== null && to.length === 0) return errText('No recipient to send to');
      const patch: Record<string, unknown> = {
        ...(to !== null ? { toRecipients: to.map(recipientOf) } : {}),
        ...(cc !== null ? { ccRecipients: cc.map(recipientOf) } : {}),
        ...(str(overrides.subject) ? { subject: str(overrides.subject) } : {}),
        ...(str(overrides.body)
          ? { body: { contentType: 'Text', content: str(overrides.body) } }
          : {}),
      };
      if (Object.keys(patch).length > 0) {
        const patched = await graphPatch(
          context,
          access.accessToken,
          `/me/messages/${encodeURIComponent(draftId)}`,
          patch
        );
        // Keep the draft: the card shows the error and the user can retry.
        if (!patched.ok) return errText(patched.error);
      }

      const sent = await sendDraft(context, access.accessToken, draftId, true);
      if (!sent.ok) return errText(sent.error);
      logger.info('outlook_send_draft_confirm sent', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        draftId,
      });
      return textResult('Sent.');
    }
  );

  server.registerTool(
    'outlook_discard_draft_confirm',
    {
      title: 'Outlook · Act — Discard a previewed draft (card only)',
      description:
        'Delete an email draft created by an outlook preview tool without sending it.' +
        confirmGuard('outlook_send_mail_preview (or a reply/forward preview)'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: z.object({
        draftId: z.string().min(1).describe('Draft id from a preview tool'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const draftId = str(args.draftId);
      if (!draftId) return errText('draftId is required');
      const deleted = await graphDeleteChecked(
        context,
        access.accessToken,
        `/me/messages/${encodeURIComponent(draftId)}`
      );
      if (!deleted.ok) return errText(deleted.error);
      logger.info('outlook_discard_draft_confirm discarded', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        draftId,
      });
      return textResult('Draft discarded; nothing was sent.');
    }
  );

  server.registerTool(
    'outlook_mark_message',
    {
      title: 'Outlook · Act — Mark a message read or unread',
      description:
        'Set the read/unread status of ONE message. For many messages, use ' +
        'outlook_start_bulk_mail_job instead — one job, not one call per message.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        messageId: z
          .string()
          .min(1)
          .describe('Message id from outlook_list_messages/outlook_get_message'),
        isRead: z.boolean().describe('true to mark read, false to mark unread'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const messageId = str(args.messageId);
      if (!messageId) return errText('messageId is required');
      if (typeof args.isRead !== 'boolean') return errText('isRead is required');

      const result = await graphPatch(
        context,
        access.accessToken,
        `/me/messages/${encodeURIComponent(messageId)}`,
        { isRead: args.isRead }
      );
      if (!result.ok) return errText(result.error);
      return textResult(`Marked ${args.isRead ? 'read' : 'unread'}.`);
    }
  );

  server.registerTool(
    'outlook_flag_message',
    {
      title: 'Outlook · Act — Flag or unflag a message',
      description:
        'Set a follow-up flag on ONE message (many: use outlook_start_bulk_mail_job): ' +
        '"flagged" to flag it, "complete" to mark a flagged message done, or "notFlagged" ' +
        'to clear the flag.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        messageId: z
          .string()
          .min(1)
          .describe('Message id from outlook_list_messages/outlook_get_message'),
        status: z.enum(['flagged', 'complete', 'notFlagged']).describe('Flag state to set'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const messageId = str(args.messageId);
      if (!messageId) return errText('messageId is required');
      const status = str(args.status);
      if (!status) return errText('status is required');

      const result = await graphPatch(
        context,
        access.accessToken,
        `/me/messages/${encodeURIComponent(messageId)}`,
        { flag: { flagStatus: status } }
      );
      if (!result.ok) return errText(result.error);
      return textResult(`Flag set to "${status}".`);
    }
  );

  server.registerTool(
    'outlook_categorize_message',
    {
      title: 'Outlook · Act — Categorize a message',
      description:
        'Add or remove Outlook color categories on ONE message (many: use ' +
        'outlook_start_bulk_mail_job) — the closest thing Outlook has to ' +
        'a "pin" or tag (Graph has no separate pin flag on messages). Pass add/remove to adjust ' +
        'the existing set, or replace to set the exact list (pass replace: [] to clear all ' +
        'categories).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        messageId: z
          .string()
          .min(1)
          .describe('Message id from outlook_list_messages/outlook_get_message'),
        add: z.array(z.string().min(1)).describe('Category names to add').optional(),
        remove: z.array(z.string().min(1)).describe('Category names to remove').optional(),
        replace: z
          .array(z.string())
          .describe('Set the exact category list, overriding add/remove (pass [] to clear all)')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const messageId = str(args.messageId);
      if (!messageId) return errText('messageId is required');
      const add = Array.isArray(args.add) ? args.add.map(String).filter(Boolean) : [];
      const remove = Array.isArray(args.remove) ? args.remove.map(String).filter(Boolean) : [];
      const replace = Array.isArray(args.replace)
        ? args.replace.map(String).filter(Boolean)
        : undefined;

      let categories: string[];
      if (replace) {
        categories = replace;
      } else {
        if (add.length === 0 && remove.length === 0) {
          return errText('Provide add, remove, or replace.');
        }
        const current = await graphGet(
          context,
          access.accessToken,
          `/me/messages/${encodeURIComponent(messageId)}?$select=categories`
        );
        if (!current.ok) return errText(current.error);
        const existing = Array.isArray(current.body.categories)
          ? current.body.categories.filter(
              (category): category is string => typeof category === 'string'
            )
          : [];
        categories = withCategoryChanges(existing, add, remove);
      }

      const result = await graphPatch(
        context,
        access.accessToken,
        `/me/messages/${encodeURIComponent(messageId)}`,
        { categories }
      );
      if (!result.ok) return errText(result.error);
      return textResult(
        categories.length > 0 ? `Categories: ${categories.join(', ')}.` : 'Categories cleared.'
      );
    }
  );

  server.registerTool(
    'outlook_move_message',
    {
      title: 'Outlook · Act — Move a message to another folder',
      description:
        'Move ONE message to a different mail folder (many: use outlook_start_bulk_mail_job ' +
        'with action "move" or "archive") — e.g. archive it, or file it into a project ' +
        'folder. destinationFolder accepts either a folder id from outlook_list_mail_folders, or ' +
        'a well-known folder name directly: inbox, archive, deleteditems, drafts, sentitems, ' +
        'junkemail. To archive a message, pass "archive" — no need to look up its id first.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        messageId: z
          .string()
          .min(1)
          .describe('Message id from outlook_list_messages/outlook_get_message'),
        destinationFolder: z
          .string()
          .min(1)
          .describe('Folder id, or a well-known name like "archive" or "deleteditems"'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const messageId = str(args.messageId);
      if (!messageId) return errText('messageId is required');
      const destinationFolder = str(args.destinationFolder);
      if (!destinationFolder) return errText('destinationFolder is required');

      const result = await graphPost(
        context,
        access.accessToken,
        `/me/messages/${encodeURIComponent(messageId)}/move`,
        { destinationId: destinationFolder }
      );
      if (!result.ok) return errText(result.error);
      return textResult(`Moved to "${destinationFolder}".`);
    }
  );

  server.registerTool(
    'outlook_create_mail_folder',
    {
      title: 'Outlook · Act — Create a mail folder',
      description:
        'Create a new mail folder. Omit parentFolderId for a top-level folder, or pass a folder ' +
        'id from outlook_list_mail_folders to create it nested inside that one.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        displayName: z.string().min(1).describe('Folder name'),
        parentFolderId: z
          .string()
          .describe('Create as a subfolder of this folder id (default: top-level)')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const displayName = str(args.displayName);
      if (!displayName) return errText('displayName is required');
      const parentFolderId = str(args.parentFolderId);
      const path = parentFolderId
        ? `/me/mailFolders/${encodeURIComponent(parentFolderId)}/childFolders`
        : '/me/mailFolders';

      const result = await graphPost(context, access.accessToken, path, { displayName });
      if (!result.ok) return errText(result.error);
      const folder = result.body ?? {};
      return textResult(
        `Created folder "${str(folder.displayName) || displayName}" — id: ${str(folder.id) || 'unknown'}.`
      );
    }
  );

  server.registerTool(
    'outlook_rename_mail_folder',
    {
      title: 'Outlook · Act — Rename a mail folder',
      description: 'Rename a mail folder. Does not move it or change its contents.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        folderId: z.string().min(1).describe('Folder id from outlook_list_mail_folders'),
        displayName: z.string().min(1).describe('New folder name'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const folderId = str(args.folderId);
      if (!folderId) return errText('folderId is required');
      const displayName = str(args.displayName);
      if (!displayName) return errText('displayName is required');

      const result = await graphPatch(
        context,
        access.accessToken,
        `/me/mailFolders/${encodeURIComponent(folderId)}`,
        { displayName }
      );
      if (!result.ok) return errText(result.error);
      return textResult(`Renamed to "${displayName}".`);
    }
  );

  server.registerTool(
    'outlook_delete_mail_folder',
    {
      title: 'Outlook · Act — Delete a mail folder',
      description:
        'Delete a mail folder and everything in it. Like deleting from Outlook itself, this ' +
        'moves the folder to Deleted Items rather than erasing it outright, but nested messages ' +
        'and subfolders go with it — confirm with the user before calling this.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        folderId: z.string().min(1).describe('Folder id from outlook_list_mail_folders'),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const folderId = str(args.folderId);
      if (!folderId) return errText('folderId is required');

      const result = await graphDeleteChecked(
        context,
        access.accessToken,
        `/me/mailFolders/${encodeURIComponent(folderId)}`
      );
      if (!result.ok) return errText(result.error);
      return textResult('Folder deleted (moved to Deleted Items).');
    }
  );

  server.registerTool(
    'outlook_create_event',
    {
      title: 'Outlook · Act — Create a calendar event',
      description:
        'Create an event on the connected user’s calendar. Listing attendees sends them ' +
        'invitations. Split required vs optional attendees — Graph marks each accordingly on ' +
        'the invite, and outlook_find_meeting_times uses the same split to weigh availability ' +
        "(required attendees' conflicts rule out a slot; optional attendees' do not). Acts as " +
        'the user — only schedule what they asked for.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        subject: z.string().min(1).describe('Event title'),
        start: z.string().min(1).describe('Start, ISO-8601 local time (e.g. 2026-08-12T15:00:00)'),
        end: z.string().min(1).describe('End, ISO-8601 local time'),
        timezone: z
          .string()
          .describe('IANA timezone for start/end (default UTC, e.g. America/Chicago)')
          .optional(),
        requiredAttendees: z
          .array(z.string().min(1))
          .describe('Required attendee email addresses — each receives an invite')
          .optional(),
        optionalAttendees: z
          .array(z.string().min(1))
          .describe('Optional attendee email addresses — each receives an invite marked optional')
          .optional(),
        body: z.string().describe('Description shown on the invite, plain text').optional(),
        location: z.string().describe('Location text').optional(),
        onlineMeeting: z
          .boolean()
          .describe('Attach a Teams meeting link (default false)')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const timezone = str(args.timezone) || 'UTC';
      const requiredAttendees = Array.isArray(args.requiredAttendees)
        ? args.requiredAttendees.map(String).filter(Boolean)
        : [];
      const optionalAttendees = Array.isArray(args.optionalAttendees)
        ? args.optionalAttendees.map(String).filter(Boolean)
        : [];
      const attendees = [
        ...requiredAttendees.map((address) => ({ emailAddress: { address }, type: 'required' })),
        ...optionalAttendees.map((address) => ({ emailAddress: { address }, type: 'optional' })),
      ];

      const result = await graphPost(context, access.accessToken, '/me/events', {
        subject: str(args.subject),
        start: { dateTime: str(args.start), timeZone: timezone },
        end: { dateTime: str(args.end), timeZone: timezone },
        ...(str(args.body) ? { body: { contentType: 'Text', content: str(args.body) } } : {}),
        ...(str(args.location) ? { location: { displayName: str(args.location) } } : {}),
        ...(attendees.length > 0 ? { attendees } : {}),
        ...(args.onlineMeeting === true
          ? { isOnlineMeeting: true, onlineMeetingProvider: 'teamsForBusiness' }
          : {}),
      });
      if (!result.ok) return errText(result.error);
      const event = result.body ?? {};
      logger.info('outlook_create_event created', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        eventId: str(event.id),
      });
      const title = str(event.subject) || str(args.subject);
      return {
        ...textResult(
          `Created "${title}" (id ${str(event.id) || 'unknown'})` +
            (requiredAttendees.length > 0 ? `; required: ${requiredAttendees.join(', ')}` : '') +
            (optionalAttendees.length > 0 ? `; optional: ${optionalAttendees.join(', ')}` : '') +
            '.' +
            (str(event.webLink) ? `\n[Open in Outlook](${str(event.webLink)})` : '')
        ),
        // The meeting's own title, for the same reason a sent mail carries
        // its subject: it is the half of "Scheduled a meeting" a person
        // needs in order to know WHICH meeting.
        _meta: actMeta({
          ...(title ? { id: `“${title}”` } : {}),
          ...(str(event.webLink) ? { url: str(event.webLink) } : {}),
        }),
      };
    }
  );

  server.registerTool(
    'outlook_find_meeting_times',
    {
      title: 'Outlook · Read — Find meeting times',
      description:
        "Suggest meeting slots within a window, checking the connected user's calendar and " +
        "every named attendee's free/busy — not just the user's own availability. Required " +
        "attendees' conflicts rule a slot out; optional attendees' conflicts only lower its " +
        'confidence. Always call this before outlook_create_event when a meeting involves other ' +
        'people and no specific time was given — propose the top suggestions (with who is free ' +
        'vs busy) and let the user pick, rather than guessing a time. If duration, a date range, ' +
        'or attendees are missing, ask the user for them instead of assuming.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        requiredAttendees: z
          .array(z.string().min(1))
          .describe('Required attendee email addresses — availability that must be free')
          .optional(),
        optionalAttendees: z
          .array(z.string().min(1))
          .describe('Optional attendee email addresses — availability that is nice to have')
          .optional(),
        durationMinutes: z
          .number()
          .int()
          .min(5)
          .max(24 * 60)
          .describe('Meeting length in minutes'),
        earliestStart: z
          .string()
          .min(1)
          .describe('Earliest acceptable start, ISO-8601 local time (e.g. 2026-08-12T08:00:00)'),
        latestEnd: z.string().min(1).describe('Latest acceptable end, ISO-8601 local time'),
        timezone: z
          .string()
          .describe('IANA timezone for the window (default UTC, e.g. America/Chicago)')
          .optional(),
        max: z
          .number()
          .int()
          .min(1)
          .max(20)
          .describe('How many suggestions (default 10)')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const requiredAttendees = Array.isArray(args.requiredAttendees)
        ? args.requiredAttendees.map(String).filter(Boolean)
        : [];
      const optionalAttendees = Array.isArray(args.optionalAttendees)
        ? args.optionalAttendees.map(String).filter(Boolean)
        : [];
      const durationMinutes = typeof args.durationMinutes === 'number' ? args.durationMinutes : 0;
      if (durationMinutes <= 0) return errText('durationMinutes is required');
      const earliestStart = str(args.earliestStart);
      const latestEnd = str(args.latestEnd);
      if (!earliestStart || !latestEnd) return errText('earliestStart and latestEnd are required');
      const timezone = str(args.timezone) || 'UTC';
      const max = typeof args.max === 'number' ? args.max : 10;

      const result = await graphPost(context, access.accessToken, '/me/findMeetingTimes', {
        attendees: [
          ...requiredAttendees.map((address) => ({ emailAddress: { address }, type: 'required' })),
          ...optionalAttendees.map((address) => ({ emailAddress: { address }, type: 'optional' })),
        ],
        timeConstraint: {
          activityDomain: 'work',
          timeslots: [
            {
              start: { dateTime: earliestStart, timeZone: timezone },
              end: { dateTime: latestEnd, timeZone: timezone },
            },
          ],
        },
        meetingDuration: `PT${durationMinutes}M`,
        returnSuggestionReasons: true,
        maxCandidates: max,
        // Every required attendee must be free; optional attendees only affect confidence.
        minimumAttendeePercentage: requiredAttendees.length > 0 ? 100 : 0,
      });
      if (!result.ok) return errText(result.error);
      const body = result.body ?? {};
      const suggestions = Array.isArray(body.meetingTimeSuggestions)
        ? body.meetingTimeSuggestions
        : [];
      if (suggestions.length === 0) {
        const reason = str(body.emptySuggestionsReason);
        return textResult(
          'No suggestions in that window' +
            (reason ? ` (${reason}).` : '.') +
            ' Try widening the date range or dropping an optional attendee.'
        );
      }

      const lines = suggestions.map((entry) => {
        const suggestion = rec(entry);
        const slot = rec(suggestion.meetingTimeSlot);
        const start = rec(slot.start);
        const end = rec(slot.end);
        const confidence = typeof suggestion.confidence === 'number' ? suggestion.confidence : 0;
        const attendeeAvailability = Array.isArray(suggestion.attendeeAvailability)
          ? suggestion.attendeeAvailability
          : [];
        const perAttendee = attendeeAvailability
          .map((a) => {
            const entryRec = rec(a);
            const attendee = rec(entryRec.attendee);
            const address = str(rec(attendee.emailAddress).address);
            const kind = str(attendee.type) || 'required';
            return `${address || '(unknown)'} [${kind}]: ${str(entryRec.availability) || 'unknown'}`;
          })
          .join('; ');
        return (
          `${str(start.dateTime)} → ${str(end.dateTime)} (${str(start.timeZone) || timezone}) — ` +
          `${confidence}% confidence` +
          (perAttendee ? `\n  ${perAttendee}` : '')
        );
      });
      return textResult(
        withPresentationHint(
          lines.join('\n\n'),
          'a table (Time, Confidence, per-attendee availability) usually makes candidate slots ' +
            'easier to compare than this flat list — present the top few, ask the user to pick.'
        )
      );
    }
  );

  server.registerTool(
    'outlook_respond_event',
    {
      title: 'Outlook · Act — Respond to a calendar invite',
      description:
        'Accept, tentatively accept, or decline an invitation on the connected user’s ' +
        'calendar — optionally with a comment, and (for tentative/decline) a proposed new ' +
        'time the organizer can accept.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        eventId: z.string().min(1).describe('Event id from outlook_list_events'),
        response: z
          .enum(['accept', 'tentative', 'decline'])
          .describe('How to respond to the invitation'),
        comment: z.string().describe('Message sent with the response').optional(),
        proposedStart: z
          .string()
          .describe('Propose a new start (ISO-8601 local) — tentative/decline only')
          .optional(),
        proposedEnd: z
          .string()
          .describe('Proposed new end — required when proposedStart is given')
          .optional(),
        timezone: z
          .string()
          .describe('IANA timezone for the proposed times (default UTC)')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const eventId = str(args.eventId);
      if (!eventId) return errText('eventId is required');
      const response = str(args.response);
      const action =
        response === 'accept'
          ? 'accept'
          : response === 'tentative'
            ? 'tentativelyAccept'
            : 'decline';

      const proposedStart = str(args.proposedStart);
      const proposedEnd = str(args.proposedEnd);
      // Graph only carries a counter-proposal on tentativelyAccept/decline —
      // an accept with a new time is a contradiction the API refuses.
      if (proposedStart && action === 'accept') {
        return errText('A new time can only be proposed with tentative or decline.');
      }
      if (proposedStart && !proposedEnd) {
        return errText('proposedEnd is required when proposedStart is given.');
      }
      const timezone = str(args.timezone) || 'UTC';

      const result = await graphPost(
        context,
        access.accessToken,
        `/me/events/${encodeURIComponent(eventId)}/${action}`,
        {
          sendResponse: true,
          ...(str(args.comment) ? { comment: str(args.comment) } : {}),
          ...(proposedStart
            ? {
                proposedNewTime: {
                  start: { dateTime: proposedStart, timeZone: timezone },
                  end: { dateTime: proposedEnd, timeZone: timezone },
                },
              }
            : {}),
        }
      );
      if (!result.ok) return errText(result.error);
      logger.info('outlook_respond_event responded', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        eventId,
        response,
      });
      /*
        Accepting and declining are opposite news, and one tool name cannot
        say which happened — so the handler says it, in the receipt. This is
        the case ActReceipt.label exists for.

        The link is best-effort and deliberately AFTER the response: Graph's
        accept/decline endpoints answer 202 with no body, and a declined
        event is often gone from the calendar by the time we ask, which
        yields no link. That is the right outcome rather than a bug — a
        notification about turning something down has nothing to open.
      */
      const answered =
        response === 'accept'
          ? 'Accepted a meeting invitation'
          : response === 'tentative'
            ? 'Tentatively accepted a meeting invitation'
            : 'Declined a meeting invitation';
      const still = await graphGet(
        context,
        access.accessToken,
        `/me/events/${encodeURIComponent(eventId)}?$select=subject,webLink`
      );
      const event = still.ok ? (still.body ?? {}) : {};
      const title = str(event.subject);

      return {
        ...textResult(
          `Responded "${response}"${str(args.comment) ? ' with a comment' : ''}` +
            (proposedStart ? `, proposing ${proposedStart} → ${proposedEnd} (${timezone}).` : '.')
        ),
        _meta: actMeta({
          label: title ? `${answered} to “${title}”` : answered,
          ...(str(event.webLink) ? { url: str(event.webLink) } : {}),
        }),
      };
    }
  );

  const cancelEventSchema = z.object({
    eventId: z.string().min(1).describe('Event id from outlook_list_events'),
    comment: z
      .string()
      .describe('Message sent with the cancellation (used only when the user is the organizer)')
      .optional(),
  });

  server.registerTool(
    'outlook_cancel_event_preview',
    {
      title: 'Outlook · Act — Preview canceling a calendar event',
      description:
        'Show the user an interactive preview card to cancel a calendar event — the card does ' +
        'the canceling. As the organizer this cancels for every attendee (a cancellation is ' +
        'sent); as an attendee it only removes the event from their calendar. Always use this ' +
        'card — canceling notifies people.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: cancelEventSchema,
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const eventId = str(args.eventId);
      if (!eventId) return errText('eventId is required');
      const result = await graphGet(
        context,
        access.accessToken,
        `/me/events/${encodeURIComponent(eventId)}` +
          `?$select=id,subject,start,end,organizer,attendees,location,isOrganizer`
      );
      if (!result.ok) return errText(result.error);
      const event = result.body;
      const isOrganizer = event.isOrganizer === true;
      const subject = str(event.subject) || '(no subject)';
      const organizer = rec(rec(event.organizer).emailAddress);
      const attendeeCount = Array.isArray(event.attendees) ? event.attendees.length : 0;
      const comment = str(args.comment);
      const where = str(rec(event.location).displayName);
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `The cancellation of "${subject}" is awaiting the user's decision on the preview ` +
              `card. Do not cancel it another way and do not repeat its contents in your reply; ` +
              `the user confirms or cancels from the card. If no card appeared in this client, ` +
              `ask the user how to proceed.`,
          },
        ],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: isOrganizer ? 'Cancel event' : 'Remove event from calendar',
          subtitle: subject,
          confirmTool: 'outlook_cancel_event_confirm',
          confirmLabel: isOrganizer ? 'Cancel event' : 'Remove',
          confirmArgs: { eventId, ...(comment ? { comment } : {}) },
          fields: [
            { label: 'Event', value: subject },
            {
              label: 'When',
              value: `${str(rec(event.start).dateTime)} → ${str(rec(event.end).dateTime)}`,
            },
            {
              label: 'Organizer',
              value: str(organizer.name) || str(organizer.address) || '(unknown)',
            },
            { label: 'Attendees', value: String(attendeeCount) },
            ...(where ? [{ label: 'Where', value: where }] : []),
            {
              label: 'Effect',
              value: isOrganizer
                ? 'Cancels the event for every attendee — a cancellation is sent.'
                : 'Removes it from your calendar only; the organizer’s event is untouched.',
            },
            ...(comment && isOrganizer ? [{ label: 'Message', value: comment }] : []),
          ],
        },
      };
    }
  );

  server.registerTool(
    'outlook_cancel_event_confirm',
    {
      title: 'Outlook · Act — Cancel a previewed event (card only)',
      description:
        'Cancel (or, as a non-organizer, remove) a calendar event the user approved on a ' +
        'preview card.' +
        confirmGuard('outlook_cancel_event_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: cancelEventSchema,
    },
    async (args: Record<string, any>) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const eventId = str(args.eventId);
      if (!eventId) return errText('eventId is required');
      // The organizer/attendee split is re-checked HERE, never trusted from
      // the card's args: the card passes confirmArgs through verbatim, and
      // organizer-cancel vs self-remove must not be forgeable (or stale).
      const lookup = await graphGet(
        context,
        access.accessToken,
        `/me/events/${encodeURIComponent(eventId)}?$select=id,subject,isOrganizer`
      );
      if (!lookup.ok) return errText(lookup.error);
      const subject = str(lookup.body.subject) || '(no subject)';
      const isOrganizer = lookup.body.isOrganizer === true;

      if (isOrganizer) {
        const comment = str(args.comment);
        const result = await graphPost(
          context,
          access.accessToken,
          `/me/events/${encodeURIComponent(eventId)}/cancel`,
          comment ? { comment } : {}
        );
        if (!result.ok) return errText(result.error);
        logger.info('outlook_cancel_event_confirm cancelled event', {
          component: 'mcp/tool',
          tenantId: context.tenantId,
          eventId,
          role: 'organizer',
        });
        return textResult(`Cancelled "${subject}" — attendees were notified.`);
      }

      const removal = await graphDeleteChecked(
        context,
        access.accessToken,
        `/me/events/${encodeURIComponent(eventId)}`
      );
      if (!removal.ok) return errText(removal.error);
      logger.info('outlook_cancel_event_confirm removed event', {
        component: 'mcp/tool',
        tenantId: context.tenantId,
        eventId,
        role: 'attendee',
      });
      return textResult(`Removed "${subject}" from your calendar.`);
    }
  );
}
