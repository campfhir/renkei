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
 * The grant is resolved from the database on every call rather than baked
 * into the handler closure: tokens rotate on refresh, handlers are cached,
 * and a stale closure was exactly the failure mode the Jira tools solved
 * with a token-cache layer. Tool volume here is low enough to read fresh.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  getGrant,
  refreshGrantTokens,
  MICROSOFT,
  MicrosoftAdapter,
  type ProviderGrant,
} from '@renkei/provider-grants';
import { GRAPH_BASE_URL } from '@renkei/connector-microsoft';
import { parseEncryptionKey } from '@renkei/crypto';
import { getDatabase } from '@renkei/db';
import { getMicrosoftApp } from '@/lib/microsoft-app';
import { logger, secure } from '@/lib/logger';
import { withScopeGate } from '../capability-gate';
import type { MCPToolContext } from '../common';

export const OUTLOOK_MCP_CONNECTOR = 'microsoft';

/** Refresh when the token is inside this window of expiry. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

interface OutlookAccess {
  accessToken: string;
  upn: string | null;
}

/** The caller's live Graph token, refreshed through the adapter when stale. */
async function resolveOutlookAccess(context: MCPToolContext): Promise<OutlookAccess | string> {
  if (!context.subject) return 'No signed-in subject on this MCP session.';
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return 'Server misconfigured (encryption key).';
  const dbResult = getDatabase();
  if (!dbResult.ok) return 'Database unavailable.';

  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', context.tenantId)
    .where('provider', '=', MICROSOFT)
    .where('subject', '=', context.subject)
    .executeTakeFirst();
  if (!row) {
    return 'Microsoft is not connected. Connect it on the Connectors page, then try again.';
  }

  const grantResult = await getGrant(
    MICROSOFT,
    context.tenantId,
    row.provider_account_id,
    keyResult.val
  );
  if (!grantResult.ok || !grantResult.val) return 'Could not read the Microsoft grant.';
  let grant: ProviderGrant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    const app = await getMicrosoftApp(context.tenantId, context.origin ?? '');
    if (!app) return 'Microsoft integration is no longer configured.';
    // The grant's own tid keeps refresh pointed at the directory that
    // minted it; the connector setting is the fallback for older grants.
    const tid =
      typeof grant.metadata.tid === 'string' && grant.metadata.tid
        ? grant.metadata.tid
        : app.directoryTenantId;
    const refreshed = await refreshGrantTokens(
      new MicrosoftAdapter(app.clientSecret, tid),
      context.tenantId,
      grant.accountId,
      keyResult.val,
      logger
    );
    if (!refreshed.ok) {
      return refreshed.err.type === 'GRANT_REVOKED'
        ? 'Your Microsoft authorization was revoked. Reconnect it on the Connectors page.'
        : 'Could not refresh the Microsoft token; try again shortly.';
    }
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }

  const upn = typeof grant.metadata.upn === 'string' ? grant.metadata.upn : null;
  return { accessToken: grant.accessToken, upn };
}

function describeStatus(status: number): string {
  if (status === 403) {
    return (
      'Graph refused (403) — the grant likely lacks the needed scope, or the Entra app is ' +
      'missing the delegated permission. Reconnect Microsoft after the admin fixes the app.'
    );
  }
  if (status === 429) return 'Graph is rate limiting (429); try again shortly.';
  return `Microsoft Graph answered ${status}`;
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
    });
  } catch {
    logger.warn('Graph API unreachable', {
      component: 'outlook/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
    });
    return { ok: false, error: 'Could not reach graph.microsoft.com' };
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
    return { ok: false, error: describeStatus(response.status) };
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
    });
  } catch {
    logger.warn('Graph API unreachable', {
      component: 'outlook/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
    });
    return { ok: false, error: 'Could not reach graph.microsoft.com' };
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
    return { ok: false, error: describeStatus(response.status) };
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
    });
  } catch {
    logger.warn('Graph API unreachable', {
      component: 'outlook/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
    });
    return { ok: false, error: 'Could not reach graph.microsoft.com' };
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
    return { ok: false, error: describeStatus(response.status) };
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
    });
  } catch {
    logger.warn('Graph API unreachable', {
      component: 'outlook/fetch',
      tenantId: context.tenantId,
      subject: context.subject,
      path: pathAndQuery,
    });
    return { ok: false, error: 'Could not reach graph.microsoft.com' };
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
    return { ok: false, error: describeStatus(response.status) };
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

/**
 * A trailing note appended to a list-shaped tool result, nudging the
 * calling model toward a more scannable reply than echoing this flat text
 * back verbatim — a table, a grouped/indented layout, whatever fits the
 * data — without dictating exactly what that looks like. Cheap to add,
 * easy to ignore when a flat list is already the right call (a couple of
 * results, or the user asked for raw output).
 */
function withPresentationHint(body: string, suggestion: string): string {
  return `${body}\n\n(Presentation hint: ${suggestion})`;
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

function messageLine(message: Record<string, unknown>): string {
  const unread = message.isRead === false;
  return (
    `[${str(message.receivedDateTime)}]${unread ? ' (unread)' : ''} ${senderOf(message)} — ` +
    `${str(message.subject) || '(no subject)'} — id: ${str(message.id)}\n  ` +
    `${str(message.bodyPreview).replace(/\n/g, '\n  ')}`
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

/** `current` categories with `add` merged in and `remove` taken out, order preserved. */
function withCategoryChanges(
  current: readonly string[],
  add: readonly string[],
  remove: readonly string[]
): string[] {
  const removeSet = new Set(remove);
  const result = current.filter((category) => !removeSet.has(category));
  for (const category of add) {
    if (!result.includes(category)) result.push(category);
  }
  return result;
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
): Promise<{ ok: true } | { ok: false; error: string }> {
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

  const needsPatch =
    options.additionalTo.length > 0 || options.cc.length > 0 || options.bcc.length > 0;
  if (needsPatch) {
    const toRecipients = unionAddresses(addressesOf(draft.toRecipients), options.additionalTo);
    const ccRecipients = unionAddresses(addressesOf(draft.ccRecipients), options.cc);
    const bccRecipients = unionAddresses(addressesOf(draft.bccRecipients), options.bcc);
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

  const sent = await graphPost(
    context,
    accessToken,
    `/me/messages/${encodeURIComponent(draftId)}/send`,
    {}
  );
  if (!sent.ok) {
    await graphDelete(context, accessToken, `/me/messages/${encodeURIComponent(draftId)}`);
    return sent;
  }
  return { ok: true };
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
function outlookScopeFor(toolName: string): string[] {
  switch (toolName) {
    case 'outlook_list_events':
    case 'outlook_get_event':
    case 'outlook_find_meeting_times':
      return ['Calendars.Read'];
    case 'outlook_list_task_lists':
    case 'outlook_list_tasks':
      return ['Tasks.Read'];
    case 'outlook_send_mail':
    case 'outlook_reply_message':
    case 'outlook_reply_all_message':
    case 'outlook_forward_message':
      return ['Mail.Send'];
    case 'outlook_mark_message':
    case 'outlook_flag_message':
    case 'outlook_categorize_message':
    case 'outlook_move_message':
      return ['Mail.ReadWrite'];
    case 'outlook_create_mail_folder':
    case 'outlook_rename_mail_folder':
    case 'outlook_delete_mail_folder':
      return ['MailboxFolder.ReadWrite'];
    case 'outlook_create_event':
    case 'outlook_respond_event':
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

/** `$search` against the directory requires the eventual-consistency header. */
const DIRECTORY_SEARCH_HEADERS = { ConsistencyLevel: 'eventual' };

const USER_SELECT =
  '$select=id,displayName,jobTitle,department,officeLocation,mail,userPrincipalName,' +
  'businessPhones,mobilePhone';

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
  context: MCPToolContext
): Promise<void> {
  // A tool whose scope this user's grant does not carry is not registered at
  // all — the org may have narrowed the checkboxes, or the user narrowed
  // their own connect.
  const server = withScopeGate(rawServer, context.graphScopes, (name) => outlookScopeFor(name));

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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
      if (typeof access === 'string') return errText(access);
      const query = str(args.query).replace(/"/g, '');
      if (!query) return errText('query is required');
      const max = typeof args.max === 'number' ? args.max : 15;
      const search = encodeURIComponent(`"displayName:${query}" OR "mail:${query}"`);
      const result = await graphGet(
        context,
        access.accessToken,
        `/users?$search=${search}&$count=true&$top=${max}&${USER_SELECT}`,
        DIRECTORY_SEARCH_HEADERS
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map((user) => `${userLine(user)} — id: ${str(user.id)}`);
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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
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
      return textResult(`Sent to ${[...to, ...cc].join(', ')}.`);
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
      const access = await resolveOutlookAccess(context);
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
      return textResult(
        'Reply sent.' +
          (additionalTo.length > 0 ? ` Also to: ${additionalTo.join(', ')}.` : '') +
          (cc.length > 0 ? ` Cc: ${cc.join(', ')}.` : '') +
          (bcc.length > 0 ? ` Bcc: ${bcc.join(', ')}.` : '')
      );
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
      const access = await resolveOutlookAccess(context);
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
      return textResult(
        'Reply-all sent.' +
          (additionalTo.length > 0 ? ` Also to: ${additionalTo.join(', ')}.` : '') +
          (cc.length > 0 ? ` Cc: ${cc.join(', ')}.` : '') +
          (bcc.length > 0 ? ` Bcc: ${bcc.join(', ')}.` : '')
      );
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
      const access = await resolveOutlookAccess(context);
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
      return textResult(
        `Forwarded to ${to.join(', ')}.` +
          (cc.length > 0 ? ` Cc: ${cc.join(', ')}.` : '') +
          (bcc.length > 0 ? ` Bcc: ${bcc.join(', ')}.` : '')
      );
    }
  );

  server.registerTool(
    'outlook_mark_message',
    {
      title: 'Outlook · Act — Mark a message read or unread',
      description: 'Set the read/unread status of a message.',
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
      const access = await resolveOutlookAccess(context);
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
        'Set a follow-up flag on a message: "flagged" to flag it, "complete" to mark a flagged ' +
        'message done, or "notFlagged" to clear the flag.',
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
      const access = await resolveOutlookAccess(context);
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
        'Add or remove Outlook color categories on a message — the closest thing Outlook has to ' +
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
      const access = await resolveOutlookAccess(context);
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
        'Move a message to a different mail folder — e.g. archive it, or file it into a project ' +
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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
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
      return textResult(
        `Created "${str(event.subject) || str(args.subject)}" (id ${str(event.id) || 'unknown'})` +
          (requiredAttendees.length > 0 ? `; required: ${requiredAttendees.join(', ')}` : '') +
          (optionalAttendees.length > 0 ? `; optional: ${optionalAttendees.join(', ')}` : '') +
          '.' +
          (str(event.webLink) ? `\n[Open in Outlook](${str(event.webLink)})` : '')
      );
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
      const access = await resolveOutlookAccess(context);
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
      const access = await resolveOutlookAccess(context);
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
      return textResult(
        `Responded "${response}"${str(args.comment) ? ' with a comment' : ''}` +
          (proposedStart ? `, proposing ${proposedStart} → ${proposedEnd} (${timezone}).` : '.')
      );
    }
  );
}
