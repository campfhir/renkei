/**
 * The admanager_* tools — operator-registered ManageEngine ADManager Plus
 * servers each person connects with their OWN ADManager Plus authtoken
 * (Connectors page). An org may run more than one (per domain, per
 * site), so every tool takes the `instanceId` that
 * admanager_list_instances reports. ADManager Plus is the sole
 * authorization authority: every operation crosses the authenticated
 * seam to apps/worker-admanager, which sends the caller's stored
 * authtoken and lets ADManager Plus's own token scope and the
 * technician's delegated rights judge the request.
 *
 * What this layer enforces is the person's PERMISSIONS, stored on the
 * connection row (packages/connector-admanager/src/permissions.ts):
 * named grants a person recognises — read accounts, unlock accounts,
 * reset passwords, create accounts, edit accounts, modify group
 * membership. Every tool names one; it registers when the caller holds
 * it on some connected instance and re-checks it on the instance named,
 * per call. Permissions can hide access the person holds; they can never
 * mint any — which is why they are checked here and deliberately not in
 * the worker.
 *
 * Coverage is deliberately narrow (see docs/admanager-connector-design.md):
 * account unlock, password reset, create/edit a user (optionally from an
 * ADManager Plus template), and security-group membership (add, remove,
 * or copy another user's groups onto a target) — not the rest of
 * ADManager Plus's REST API.
 *
 * Every write here is preview + confirm on its own purpose-built preview
 * card (`directory_action_preview` — see
 * apps/web/lib/mcp-widgets/src/directory-action-preview.ts), not the
 * generic Jira-shaped `issue_preview` card: these are identity/access
 * actions against a real employee's AD account, not a ticket, and the
 * card shows who the account belongs to and (for a generated password)
 * the value itself, neither of which the generic card renders. Every
 * write previews regardless of which permission gates it — a
 * deliberately wider net than Mirth's "only permanent operations" rule,
 * because there is no version history here to catch a model's mistake
 * after the fact.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  admanagerPermission,
  combineFilters,
  dedupeGroupNames,
  filterClause,
  groupNamesFromDns,
  groupsPresent,
  groupsToAdd,
} from '@renkei/connector-admanager';
import type { AdManagerPermission, ConnectedInstance } from '@renkei/connector-admanager';
import type { MCPToolContext } from '../common';
import { admanagerApi } from '@/lib/admanager/service-client';
import type {
  AdManagerApiRequest,
  AdManagerClientError,
  AdManagerTarget,
  WireApiResponse,
} from '@/lib/admanager/service-client';
import {
  APP_ONLY_META,
  DIRECTORY_ACTION_PREVIEW_URI,
  confirmGuard,
  newPreviewId,
  previewToolMeta,
} from '../widgets';
import { NO_SUCH_INSTANCE } from './admanager-auth';
import type { AdManagerAuth } from './admanager-auth';

/** A person's identity for the preview card — name plus a detail line (logon name/domain). */
interface CardPerson {
  name: string;
  detail?: string;
}

/** One row of the directory_action_preview card's structuredContent. */
interface DirectoryActionPreview {
  kind: 'directory_action';
  previewId: string;
  action: string;
  tone: 'positive' | 'caution' | 'neutral';
  title: string;
  subtitle: string;
  person: CardPerson;
  secondaryPerson?: { label: string; name: string; detail?: string };
  fields?: { label: string; value: string; oldValue?: string }[];
  secret?: { label: string; value: string; note?: string };
  groupLists?: { label: string; groups: string[]; tone?: 'add' | 'remove' | 'muted' }[];
  confirmTool: string;
  confirmLabel: string;
  confirmArgs: Record<string, unknown>;
}

/** The connector key the ADManager Plus capabilities register under. */
export const ADMANAGER_MCP_CONNECTOR = 'admanager';

/** What the caller may do somewhere: the union of their instances' permissions. */
export interface AdManagerToolExposure {
  permissions: readonly string[];
}

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: true;
  structuredContent?: Record<string, unknown>;
};

function textResult(text: string): ToolResult {
  return { content: [{ type: 'text' as const, text }] };
}

function errText(text: string): ToolResult {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

function parseJson(body: string): unknown {
  if (!body.trim()) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated at ${maxChars} of ${text.length} characters]`;
}

/** A random, unambiguous password for reset/create when the caller doesn't supply one. */
function generatePassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*-_=+';
  const all = upper + lower + digits + symbols;
  const pick = (set: string): string => set[Math.floor(Math.random() * set.length)];
  const required = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  const rest = Array.from({ length: 12 }, () => pick(all));
  const chars = [...required, ...rest];
  // Fisher-Yates so the required classes aren't always in the same four slots.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** "accounts: read, unlock; groups: modify" — the permissions, grouped by area. */
function permissionSummary(permissions: readonly AdManagerPermission[]): string {
  if (permissions.length === 0) return 'none';
  const byArea = new Map<string, string[]>();
  for (const id of permissions) {
    const [area, verb] = id.split('.');
    const list = byArea.get(area) ?? [];
    list.push(verb);
    byArea.set(area, list);
  }
  return [...byArea.entries()].map(([area, verbs]) => `${area}: ${verbs.join(', ')}`).join('; ');
}

function instanceLine(connected: ConnectedInstance): string {
  return (
    `${connected.instance.name} [${connected.instance.environment}] — id ${connected.instance.id} — ` +
    `${connected.instance.baseUrl} — connected as ${connected.connection.technicianName} — permissions: ` +
    permissionSummary(connected.connection.permissions)
  );
}

function clientMessage(what: string, error: AdManagerClientError): string {
  if (error.kind === 'unconfigured') {
    return 'ADManager Plus is unavailable: the ADManager Plus service is not configured on this deployment.';
  }
  if (error.kind === 'unreachable') {
    return `Could not reach the ADManager Plus service to ${what}.`;
  }
  switch (error.type) {
    case 'no_instance':
    case 'not_connected':
      // One answer for "no such instance" and "not yours": ids must not
      // become an existence oracle for instances others connected.
      return NO_SUCH_INSTANCE;
    case 'bad_credentials':
      return 'Your stored authtoken for this instance cannot be read or was rejected — reconnect it on the Connectors page.';
    case 'store':
      return 'Could not read your ADManager Plus connections.';
    case 'timeout':
      return `The ADManager Plus server did not answer in time trying to ${what}.`;
    case 'unreachable':
      return `Could not reach the ADManager Plus server to ${what}: ${error.message ?? 'no route'}.`;
    case 'too_large':
      return `The ADManager Plus server's answer was too large to ${what} here — narrow the request.`;
    default:
      return `Could not ${what}: ${error.message ?? error.type}.`;
  }
}

function upstreamMessage(what: string, response: WireApiResponse): string {
  const excerpt = clip(response.body.replace(/\s+/g, ' ').trim(), 400);
  switch (response.status) {
    case 401:
      return `ADManager Plus would not authenticate the request to ${what} — reconnect the instance on the Connectors page.`;
    case 403:
      return `ADManager Plus refused to ${what}: this authtoken's scope does not permit it.`;
    case 404:
      return `ADManager Plus has nothing at that id or path (could not ${what}).`;
    default:
      return `ADManager Plus answered ${response.status} trying to ${what}${excerpt ? `: ${excerpt}` : '.'}`;
  }
}

/**
 * ADManager Plus's legacy `/RestAPI/*` write-endpoint response (unlock,
 * reset-password, force-template): either a JSON array of per-account
 * result entries, or a single `{SEVERITY, STATUS_MESSAGE}` request-level
 * error envelope. Success is a status of `1`/`"1"`/`"SUCCESS"` or a
 * success-shaped message; anything else with content is a failure. These
 * endpoints answer HTTP 200 even on a logical failure, so this is the
 * check that actually matters — `call()`'s ok:true only means the HTTP
 * layer worked.
 */
function interpretV1Response(parsed: unknown): { ok: boolean; message: string } {
  if (Array.isArray(parsed)) {
    const entry = isRecord(parsed[0]) ? parsed[0] : undefined;
    const status = entry?.status;
    const message = str(entry?.statusMessage) || str(entry?.STATUS_MESSAGE);
    const succeeded =
      status === 1 ||
      status === '1' ||
      (typeof status === 'string' && status.toUpperCase() === 'SUCCESS') ||
      /success/i.test(message);
    if (succeeded) return { ok: true, message: message || 'success' };
    if (message || status != null) return { ok: false, message: message || String(status) };
    return { ok: true, message: 'success' };
  }
  if (isRecord(parsed)) {
    const severity = str(parsed.SEVERITY);
    if (severity && severity.toUpperCase() !== 'SUCCESS') {
      return { ok: false, message: str(parsed.STATUS_MESSAGE) || severity };
    }
    return { ok: true, message: str(parsed.STATUS_MESSAGE) || 'success' };
  }
  return { ok: true, message: 'success' };
}

/**
 * ADManager Plus's v2 `PATCH /api/v2/users` response: either a request-level
 * `{IAM_ERROR_STATUS: true, eSTATUS}` rejection, or a per-item array whose
 * `status.status_code` must be `1` for success. Like the v1 endpoints, a
 * logical failure still answers HTTP 200 — this is the check that matters.
 */
function interpretV2PatchResponse(parsed: unknown): { ok: boolean; message: string } {
  if (isRecord(parsed) && parsed.IAM_ERROR_STATUS === true) {
    return { ok: false, message: str(parsed.eSTATUS) || 'ManageEngine rejected the request' };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) return { ok: true, message: 'success' };
  const entry = parsed.data.find(isRecord);
  const status = isRecord(entry?.status) ? entry.status : undefined;
  const statusCode = status?.status_code;
  const message = typeof status?.status_message === 'string' ? status.status_message : '';
  if (statusCode !== 1 && statusCode !== '1') {
    return { ok: false, message: message || 'Unknown ManageEngine error' };
  }
  return { ok: true, message };
}

const USER_FIELDS = [
  'SAM_ACCOUNT_NAME',
  'DISPLAY_NAME',
  'FIRST_NAME',
  'LAST_NAME',
  'EMAIL_ADDRESS',
  'ACCOUNT_STATUS',
  'DEPARTMENT',
  'TITLE',
  'TELEPHONE_NUMBER',
  'MANAGER',
  'DESCRIPTION',
  'OU_NAME',
  'DOMAIN_NAME',
];
const USER_FIELDS_WITH_GROUPS = [...USER_FIELDS, 'MEMBER_OF'];

function formatUser(user: Record<string, unknown>): string {
  const fields: [string, string][] = [
    ['Logon name', str(user.SAM_ACCOUNT_NAME)],
    ['Display name', str(user.DISPLAY_NAME)],
    ['Status', str(user.ACCOUNT_STATUS)],
    ['Email', str(user.EMAIL_ADDRESS)],
    ['Department', str(user.DEPARTMENT)],
    ['Title', str(user.TITLE)],
    ['Phone', str(user.TELEPHONE_NUMBER)],
    ['Manager', str(user.MANAGER)],
    ['OU', str(user.OU_NAME)],
    ['Domain', str(user.DOMAIN_NAME)],
    ['Description', str(user.DESCRIPTION)],
  ];
  const lines = fields.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`);
  const groups = groupNamesFromDns(toStringArray(user.MEMBER_OF));
  if (groups.length) lines.push(`Groups: ${groups.join(', ')}`);
  return lines.join('\n');
}

export function registerAdManagerTools(
  server: McpServer,
  context: MCPToolContext,
  auth: AdManagerAuth,
  exposure: AdManagerToolExposure
): void {
  const granted = new Set(exposure.permissions);

  /**
   * Wrap the server so a tool naming a permission this caller does not
   * hold on ANY connected instance never registers at all — the tool
   * list tells the truth about what's available. The handler re-checks
   * the permission on the instance named, per call.
   */
  const gated = (permission: AdManagerPermission): McpServer =>
    granted.has(permission)
      ? server
      : new Proxy(server, {
          get(target, property, receiver) {
            if (property === 'registerTool') return () => undefined;
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });

  const exposureRefusal = async (
    instanceId: string,
    permission: AdManagerPermission
  ): Promise<string | null> => {
    const connection = await auth.connection(instanceId);
    if (typeof connection === 'string') return connection;
    if (!connection.permissions.includes(permission)) {
      return (
        `This connection does not grant "${admanagerPermission(permission).label}". Change it on ` +
        `the Connectors page, or ask an operator to widen it.`
      );
    }
    return null;
  };

  const call = async (
    instanceId: string,
    what: string,
    request: AdManagerApiRequest
  ): Promise<{ ok: true; response: WireApiResponse } | { ok: false; message: string }> => {
    const target = auth.target();
    if (typeof target === 'string') return { ok: false, message: target };
    const full: AdManagerTarget = { ...target, instanceId };
    const answered = await admanagerApi(full, request);
    if (!answered.ok) return { ok: false, message: clientMessage(what, answered.err) };
    if (answered.val.status < 200 || answered.val.status >= 300) {
      return { ok: false, message: upstreamMessage(what, answered.val) };
    }
    return { ok: true, response: answered.val };
  };

  const instanceNameFor = async (instanceId: string): Promise<string> => {
    const connected = await auth.listConnected();
    if (typeof connected === 'string') return instanceId;
    return connected.find((entry) => entry.instance.id === instanceId)?.instance.name ?? instanceId;
  };

  /** One user record by logon name, or an error string. */
  const getUserRecord = async (
    instanceId: string,
    domainName: string,
    samAccountName: string,
    fields: readonly string[]
  ): Promise<{ ok: true; user: Record<string, unknown> } | { ok: false; message: string }> => {
    const answered = await call(instanceId, 'look up the user', {
      method: 'GET',
      path: '/api/v2/users',
      query: {
        domains: domainName,
        filter: filterClause('SAM_ACCOUNT_NAME', 'eq', samAccountName),
        fields: fields.join(','),
        limit: 1,
      },
    });
    if (!answered.ok) return answered;
    const parsed = parseJson(answered.response.body);
    const rows = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : [];
    const user = rows.find(isRecord);
    if (!user) {
      return {
        ok: false,
        message: `No user "${samAccountName}" was found in domain "${domainName}" on this instance.`,
      };
    }
    return { ok: true, user };
  };

  // -------------------------------------------------------------------
  // Read tools — registered for any connection / gated on accounts.read.
  // -------------------------------------------------------------------

  server.registerTool(
    'admanager_list_instances',
    {
      title: 'ADManager Plus · Read — List the instances you connected',
      description:
        'The ManageEngine ADManager Plus servers this user has connected with their own authtoken ' +
        '— typically one per domain or site — with what the tools may do on each (their choice on ' +
        'the Connectors page). Every other admanager_* tool takes the instanceId listed here. What ' +
        "an operation is actually allowed to do is decided by ADManager Plus judging the token's " +
        'own scope and the technician account it belongs to.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const connected = await auth.listConnected();
      if (typeof connected === 'string') return errText(connected);
      if (connected.length === 0) {
        return textResult(
          'No ADManager Plus instances are connected. Instances are connected with your own ' +
            'authtoken on the Connectors page in Renkei.'
        );
      }
      return textResult(
        `ADManager Plus instances you can use:\n${connected.map((entry) => instanceLine(entry)).join('\n')}`
      );
    }
  );

  const instanceIdField = z.string().min(1).describe('An instance id from admanager_list_instances.');
  const domainField = z.string().min(1).describe('The AD domain the account is in (e.g. corp.example.com).');
  const samField = z.string().min(1).describe('The account’s logon name (sAMAccountName), e.g. "jdoe".');

  gated('accounts.read').registerTool(
    'admanager_get_user',
    {
      title: 'ADManager Plus · Read — Look up a user',
      description:
        'A user’s attributes, account status (enabled/disabled/locked) and security-group ' +
        'membership, by logon name.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        instanceId: instanceIdField,
        domainName: domainField,
        samAccountName: samField,
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'accounts.read');
      if (refusal) return errText(refusal);
      const user = await getUserRecord(
        instanceId,
        str(args.domainName),
        str(args.samAccountName),
        USER_FIELDS_WITH_GROUPS
      );
      if (!user.ok) return errText(user.message);
      return textResult(formatUser(user.user));
    }
  );

  gated('accounts.read').registerTool(
    'admanager_search_users',
    {
      title: 'ADManager Plus · Read — Search users',
      description:
        'Search users in a domain by a free-text match against first name, last name, display ' +
        'name, logon name and email — for finding the right account before acting on it.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        instanceId: instanceIdField,
        domainName: domainField,
        query: z.string().min(1).describe('Text to match (e.g. a name).'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 25).'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'accounts.read');
      if (refusal) return errText(refusal);
      const query = str(args.query);
      const filter = combineFilters(
        ['FIRST_NAME', 'LAST_NAME', 'DISPLAY_NAME', 'SAM_ACCOUNT_NAME', 'EMAIL_ADDRESS'].map((column) =>
          filterClause(column, 'co', query)
        ),
        'or'
      );
      const limit = typeof args.limit === 'number' ? args.limit : 25;
      const answered = await call(instanceId, 'search users', {
        method: 'GET',
        path: '/api/v2/users',
        query: {
          domains: str(args.domainName),
          filter,
          limit,
          fields: 'SAM_ACCOUNT_NAME,DISPLAY_NAME,EMAIL_ADDRESS,DEPARTMENT,TITLE,ACCOUNT_STATUS',
        },
      });
      if (!answered.ok) return errText(answered.message);
      const parsed = parseJson(answered.response.body);
      const rows = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data.filter(isRecord) : [];
      if (rows.length === 0) return textResult(`No users matched "${query}".`);
      const lines = rows.map(
        (user) =>
          `${str(user.SAM_ACCOUNT_NAME)} — ${str(user.DISPLAY_NAME)} — ${str(user.ACCOUNT_STATUS) || 'unknown status'}` +
          (user.DEPARTMENT ? ` — ${str(user.DEPARTMENT)}` : '') +
          (user.EMAIL_ADDRESS ? ` — ${str(user.EMAIL_ADDRESS)}` : '')
      );
      return textResult(lines.join('\n'));
    }
  );

  // -------------------------------------------------------------------
  // Unlock account.
  // -------------------------------------------------------------------

  const unlockSchema = z.object({
    instanceId: instanceIdField,
    domainName: domainField,
    samAccountName: samField,
  });

  const unlockHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const instanceId = str(args.instanceId);
    const refusal = await exposureRefusal(instanceId, 'accounts.unlock');
    if (refusal) return errText(refusal);
    const samAccountName = str(args.samAccountName);
    const domainName = str(args.domainName);
    const answered = await call(instanceId, 'unlock the account', {
      method: 'POST',
      path: '/RestAPI/UnlockUser',
      query: {
        domainName,
        inputFormat: JSON.stringify([{ sAMAccountName: samAccountName }]),
      },
    });
    if (!answered.ok) return errText(answered.message);
    const outcome = interpretV1Response(parseJson(answered.response.body));
    if (!outcome.ok) {
      return errText(`ADManager Plus could not unlock ${samAccountName}: ${outcome.message}`);
    }
    return textResult(`Unlocked ${samAccountName} in ${domainName}.`);
  };

  gated('accounts.unlock').registerTool(
    'admanager_unlock_account_preview',
    {
      title: 'ADManager Plus · Act — Preview unlocking an account',
      description:
        'Show the user an interactive card to confirm or cancel unlocking a locked-out AD account. ' +
        'This is the only way to unlock an account here — the user decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: unlockSchema,
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'accounts.unlock');
      if (refusal) return errText(refusal);
      const samAccountName = str(args.samAccountName);
      const domainName = str(args.domainName);
      const existing = await getUserRecord(instanceId, domainName, samAccountName, [
        'DISPLAY_NAME',
        'ACCOUNT_STATUS',
      ]);
      if (!existing.ok) return errText(existing.message);
      const instanceName = await instanceNameFor(instanceId);
      const displayName = str(existing.user.DISPLAY_NAME) || samAccountName;
      const preview: DirectoryActionPreview = {
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Unlock account',
        tone: 'positive',
        title: `Unlock ${displayName}`,
        subtitle: `${instanceName} · ${domainName}`,
        person: { name: displayName, detail: `${samAccountName} · ${domainName}` },
        fields: [{ label: 'Current status', value: str(existing.user.ACCOUNT_STATUS) || 'unknown' }],
        confirmTool: 'admanager_unlock_account_confirm',
        confirmLabel: 'Unlock account',
        confirmArgs: args,
      };
      return {
        content: [{ type: 'text' as const, text: 'A card is shown for the user to confirm or cancel.' }],
        structuredContent: preview,
      };
    }
  );

  gated('accounts.unlock').registerTool(
    'admanager_unlock_account_confirm',
    {
      title: 'ADManager Plus · Act — Execute a confirmed account unlock',
      description: 'Unlock the account the user confirmed on the preview card. ' + confirmGuard('admanager_unlock_account_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: unlockSchema,
    },
    unlockHandler
  );

  // -------------------------------------------------------------------
  // Reset password.
  // -------------------------------------------------------------------

  const resetPasswordSchema = z.object({
    instanceId: instanceIdField,
    domainName: domainField,
    samAccountName: samField,
    newPassword: z
      .string()
      .min(1)
      .optional()
      .describe('The new password. Omit to have Renkei generate a strong one.'),
    mustChangePassword: z
      .boolean()
      .optional()
      .describe('Force the user to change it at next logon (default true).'),
    resetPasswordTemplateName: z
      .string()
      .optional()
      .describe(
        'An ADManager Plus template name that forces "must change password at next logon" — ' +
          'ADManager Plus can only set that flag through a template, so it is required whenever ' +
          'mustChangePassword is true.'
      ),
  });

  const resetPasswordHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const instanceId = str(args.instanceId);
    const refusal = await exposureRefusal(instanceId, 'accounts.reset_password');
    if (refusal) return errText(refusal);
    const samAccountName = str(args.samAccountName);
    const domainName = str(args.domainName);
    const newPassword = str(args.newPassword) || generatePassword();
    const mustChangePassword = args.mustChangePassword !== false;
    const templateName = str(args.resetPasswordTemplateName);
    if (mustChangePassword && !templateName) {
      return errText(
        'Forcing a password change at next logon needs an ADManager Plus template name ' +
          '(resetPasswordTemplateName) — ADManager Plus can only apply that setting through a ' +
          'template. Pass mustChangePassword: false to reset without forcing a change, or supply ' +
          'the template.'
      );
    }

    const reset = await call(instanceId, 'reset the password', {
      method: 'POST',
      path: '/RestAPI/ResetPwd',
      query: {
        domainName,
        passwordType: 'password',
        pwd: newPassword,
        inputFormat: JSON.stringify([{ sAMAccountName: samAccountName }]),
      },
    });
    if (!reset.ok) return errText(reset.message);
    const resetOutcome = interpretV1Response(parseJson(reset.response.body));
    if (!resetOutcome.ok) {
      return errText(`ADManager Plus could not reset the password for ${samAccountName}: ${resetOutcome.message}`);
    }

    if (mustChangePassword && templateName) {
      // ResetPwd cannot touch pwdLastSet, so a template applied through
      // ModifyUser is what actually forces the change — and ModifyUser
      // locates the account by AD's own EMPLOYEE_ID, not sAMAccountName.
      const lookup = await getUserRecord(instanceId, domainName, samAccountName, ['EMPLOYEE_ID']);
      const employeeID = lookup.ok ? str(lookup.user.EMPLOYEE_ID) : '';
      if (!employeeID) {
        const reason = lookup.ok ? 'this account has no EMPLOYEE_ID in AD' : lookup.message;
        return textResult(
          `Password reset for ${samAccountName} in ${domainName}, but "must change at next logon" ` +
            `could not be applied: ${reason}. New password: ${newPassword}`
        );
      }
      const modify = await call(instanceId, 'force a password change at next logon', {
        method: 'POST',
        path: '/RestAPI/ModifyUser',
        query: { inputFormat: JSON.stringify([{ employeeID, templateName }]) },
      });
      const modifyOutcome = modify.ok ? interpretV1Response(parseJson(modify.response.body)) : null;
      if (!modify.ok || !modifyOutcome?.ok) {
        const detail = modify.ok ? modifyOutcome?.message : modify.message;
        return textResult(
          `Password reset for ${samAccountName} in ${domainName}, but could not force a change at ` +
            `next logon: ${detail}. New password: ${newPassword}`
        );
      }
    }

    return textResult(`Password reset for ${samAccountName} in ${domainName}. New password: ${newPassword}`);
  };

  gated('accounts.reset_password').registerTool(
    'admanager_reset_password_preview',
    {
      title: 'ADManager Plus · Act — Preview a password reset',
      description:
        'Show the user an interactive card to confirm or cancel resetting an AD account’s ' +
        'password. When no password is given, a strong one is generated and shown on the card so ' +
        'it can be relayed to the employee.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: resetPasswordSchema,
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'accounts.reset_password');
      if (refusal) return errText(refusal);
      const samAccountName = str(args.samAccountName);
      const domainName = str(args.domainName);
      const mustChangePassword = args.mustChangePassword !== false;
      const templateName = str(args.resetPasswordTemplateName);
      if (mustChangePassword && !templateName) {
        return errText(
          'Forcing a password change at next logon needs an ADManager Plus template name ' +
            '(resetPasswordTemplateName) — pass mustChangePassword: false to reset without forcing ' +
            'a change, or supply the template.'
        );
      }
      const existing = await getUserRecord(instanceId, domainName, samAccountName, ['DISPLAY_NAME']);
      if (!existing.ok) return errText(existing.message);
      const newPassword = str(args.newPassword) || generatePassword();
      const instanceName = await instanceNameFor(instanceId);
      const displayName = str(existing.user.DISPLAY_NAME) || samAccountName;
      // The password is resolved HERE and carried in confirmArgs, so confirm
      // uses exactly what the human sees on the card — never regenerated.
      const confirmArgs = { ...args, newPassword, mustChangePassword };
      const preview: DirectoryActionPreview = {
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Reset password',
        tone: 'caution',
        title: `Reset password for ${displayName}`,
        subtitle: `${instanceName} · ${domainName}`,
        person: { name: displayName, detail: `${samAccountName} · ${domainName}` },
        secret: {
          label: 'New password',
          value: newPassword,
          note: 'Share this with the account holder directly — it is shown here only once.',
        },
        fields: [
          { label: 'Must change at next logon', value: mustChangePassword ? 'Yes' : 'No' },
          ...(templateName ? [{ label: 'Template', value: templateName }] : []),
        ],
        confirmTool: 'admanager_reset_password_confirm',
        confirmLabel: 'Reset password',
        confirmArgs,
      };
      return {
        content: [{ type: 'text' as const, text: 'A card is shown for the user to confirm or cancel.' }],
        structuredContent: preview,
      };
    }
  );

  gated('accounts.reset_password').registerTool(
    'admanager_reset_password_confirm',
    {
      title: 'ADManager Plus · Act — Execute a confirmed password reset',
      description:
        'Reset the password the user confirmed on the preview card. ' +
        confirmGuard('admanager_reset_password_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: resetPasswordSchema,
    },
    resetPasswordHandler
  );

  // -------------------------------------------------------------------
  // Create user (optionally from a template).
  // -------------------------------------------------------------------

  const createUserSchema = z.object({
    instanceId: instanceIdField,
    domainName: domainField,
    ouPath: z.string().min(1).describe('Distinguished name of the target OU, e.g. "OU=Users,DC=corp,DC=example".'),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    sAMAccountName: samField,
    userPrincipalName: z.string().min(1).describe('UPN, e.g. "jdoe@corp.example.com".'),
    email: z.string().optional(),
    department: z.string().optional(),
    title: z.string().optional(),
    telephoneNumber: z.string().optional(),
    templateName: z
      .string()
      .optional()
      .describe('An ADManager Plus user-creation template to apply, by name.'),
    password: z
      .string()
      .min(1)
      .optional()
      .describe('The initial password. Omit to have Renkei generate a strong one.'),
    enabled: z.boolean().optional().describe('Account enabled state (default true).'),
  });

  /** The flat attribute object ADManager Plus's v1 CreateUser takes as one `inputFormat` entry. */
  function createUserBody(args: Record<string, unknown>, password: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      sAMAccountName: str(args.sAMAccountName),
      givenName: str(args.firstName),
      sn: str(args.lastName),
      name: `${str(args.firstName)} ${str(args.lastName)}`.trim(),
      userPrincipalName: str(args.userPrincipalName),
      OUName: str(args.ouPath),
      password,
    };
    if (args.email) body.mail = str(args.email);
    if (args.department) body.department = str(args.department);
    if (args.title) body.title = str(args.title);
    if (args.telephoneNumber) body.telephoneNumber = str(args.telephoneNumber);
    const templateName = str(args.templateName);
    if (templateName) body.templateName = templateName;
    return body;
  }

  const createUserHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const instanceId = str(args.instanceId);
    const refusal = await exposureRefusal(instanceId, 'accounts.create');
    if (refusal) return errText(refusal);
    const domainName = str(args.domainName);
    const samAccountName = str(args.sAMAccountName);
    const password = str(args.password) || generatePassword();
    const created = await call(instanceId, 'create the user', {
      method: 'POST',
      path: '/RestAPI/CreateUser',
      query: {
        domainName,
        inputFormat: JSON.stringify([createUserBody(args, password)]),
      },
    });
    if (!created.ok) return errText(created.message);

    // Success is a JSONArray of per-user entries; a request-level failure
    // (bad OU, duplicate account, …) comes back as a single error envelope.
    const parsed = parseJson(created.response.body);
    if (!Array.isArray(parsed)) {
      const message = isRecord(parsed) ? str(parsed.STATUS_MESSAGE) : '';
      return errText(`ADManager Plus could not create the user: ${message || 'unknown error'}`);
    }
    const entry = parsed.find(isRecord);
    if (!entry || str(entry.status).toUpperCase() !== 'SUCCESS') {
      const message = entry ? str(entry.statusMessage) || str(entry.STATUS_MESSAGE) : '';
      return errText(`ADManager Plus could not create the user: ${message || 'no success entry in response'}`);
    }

    if (args.enabled === false) {
      const disabled = await call(instanceId, 'disable the newly created account', {
        method: 'POST',
        path: '/RestAPI/DisableUser',
        query: { domainName, inputFormat: JSON.stringify([{ sAMAccountName: samAccountName }]) },
      });
      const disableOutcome = disabled.ok ? interpretV1Response(parseJson(disabled.response.body)) : null;
      if (!disabled.ok || !disableOutcome?.ok) {
        return textResult(
          `Created ${samAccountName} in ${domainName}, but could not leave the account disabled as ` +
            `requested. Password: ${password}`
        );
      }
    }

    return textResult(`Created ${samAccountName} in ${domainName}. Password: ${password}`);
  };

  gated('accounts.create').registerTool(
    'admanager_create_user_preview',
    {
      title: 'ADManager Plus · Act — Preview creating a user',
      description:
        'Show the user an interactive card to confirm or cancel creating a new AD user account, ' +
        'optionally from an ADManager Plus template. When no password is given, a strong one is ' +
        'generated and shown on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: createUserSchema,
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'accounts.create');
      if (refusal) return errText(refusal);
      const password = str(args.password) || generatePassword();
      const instanceName = await instanceNameFor(instanceId);
      const confirmArgs = { ...args, password };
      const displayName = `${str(args.firstName)} ${str(args.lastName)}`.trim();
      const preview: DirectoryActionPreview = {
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Create account',
        tone: 'positive',
        title: `Create ${displayName}`,
        subtitle: `${instanceName} · ${str(args.domainName)}`,
        person: { name: displayName, detail: `${str(args.sAMAccountName)} · ${str(args.domainName)}` },
        fields: [
          { label: 'OU', value: str(args.ouPath) },
          { label: 'UPN', value: str(args.userPrincipalName) },
          ...(args.email ? [{ label: 'Email', value: str(args.email) }] : []),
          ...(args.department ? [{ label: 'Department', value: str(args.department) }] : []),
          ...(args.title ? [{ label: 'Title', value: str(args.title) }] : []),
          ...(args.templateName ? [{ label: 'Template', value: str(args.templateName) }] : []),
          { label: 'Enabled', value: args.enabled === false ? 'No' : 'Yes' },
        ],
        secret: { label: 'Initial password', value: password },
        confirmTool: 'admanager_create_user_confirm',
        confirmLabel: 'Create account',
        confirmArgs,
      };
      return {
        content: [{ type: 'text' as const, text: 'A card is shown for the user to confirm or cancel.' }],
        structuredContent: preview,
      };
    }
  );

  gated('accounts.create').registerTool(
    'admanager_create_user_confirm',
    {
      title: 'ADManager Plus · Act — Execute a confirmed user creation',
      description:
        'Create the account the user confirmed on the preview card. ' +
        confirmGuard('admanager_create_user_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: createUserSchema,
    },
    createUserHandler
  );

  // -------------------------------------------------------------------
  // Update user (attributes only — never group membership; see below).
  // -------------------------------------------------------------------

  const updateUserSchema = z.object({
    instanceId: instanceIdField,
    domainName: domainField,
    samAccountName: samField,
    department: z.string().optional(),
    title: z.string().optional(),
    telephoneNumber: z.string().optional(),
    email: z.string().optional(),
    description: z.string().optional(),
    manager: z.string().optional().describe('The manager’s name or distinguished name.'),
    templateName: z
      .string()
      .optional()
      .describe('An ADManager Plus template to reapply, by name.'),
  });

  const EDITABLE_FIELDS: readonly [string, string][] = [
    ['department', 'department'],
    ['title', 'title'],
    ['telephoneNumber', 'telephoneNumber'],
    ['email', 'mail'],
    ['description', 'description'],
    ['manager', 'manager'],
  ];

  function updateUserBody(args: Record<string, unknown>): Record<string, unknown> {
    const attributes: Record<string, unknown> = {};
    for (const [argKey, attrKey] of EDITABLE_FIELDS) {
      if (typeof args[argKey] === 'string' && args[argKey]) attributes[attrKey] = args[argKey];
    }
    const templateName = str(args.templateName);
    return {
      ...(templateName ? { template: { template_name: templateName } } : {}),
      data: { attributes },
    };
  }

  const updateUserHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const instanceId = str(args.instanceId);
    const refusal = await exposureRefusal(instanceId, 'accounts.edit');
    if (refusal) return errText(refusal);
    const samAccountName = str(args.samAccountName);
    const domainName = str(args.domainName);
    const answered = await call(instanceId, 'update the user', {
      method: 'PATCH',
      path: '/api/v2/users',
      query: { domain: domainName, filter: filterClause('SAM_ACCOUNT_NAME', 'eq', samAccountName) },
      body: updateUserBody(args),
    });
    if (!answered.ok) return errText(answered.message);
    const outcome = interpretV2PatchResponse(parseJson(answered.response.body));
    if (!outcome.ok) {
      return errText(`ADManager Plus could not update ${samAccountName}: ${outcome.message}`);
    }
    return textResult(
      [
        `Updated ${samAccountName} in ${domainName}.`,
        ...(outcome.message && outcome.message !== 'success' ? [outcome.message] : []),
      ].join('\n')
    );
  };

  gated('accounts.edit').registerTool(
    'admanager_update_user_preview',
    {
      title: 'ADManager Plus · Act — Preview editing a user',
      description:
        'Show the user an interactive card to confirm or cancel updating an AD user’s ' +
        'attributes (department, title, phone, email, description, manager), optionally ' +
        'reapplying a template. Never changes security-group membership — use the group tools for ' +
        'that.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: updateUserSchema,
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'accounts.edit');
      if (refusal) return errText(refusal);
      const samAccountName = str(args.samAccountName);
      const domainName = str(args.domainName);
      const changed = EDITABLE_FIELDS.filter(([argKey]) => typeof args[argKey] === 'string' && args[argKey]);
      if (changed.length === 0 && !args.templateName) {
        return errText('Give at least one attribute to change, or a template to reapply.');
      }
      const existing = await getUserRecord(instanceId, domainName, samAccountName, [
        'DISPLAY_NAME',
        'DEPARTMENT',
        'TITLE',
        'TELEPHONE_NUMBER',
        'EMAIL_ADDRESS',
        'DESCRIPTION',
        'MANAGER',
      ]);
      if (!existing.ok) return errText(existing.message);
      const instanceName = await instanceNameFor(instanceId);
      const displayName = str(existing.user.DISPLAY_NAME) || samAccountName;
      const fieldLabels: Record<string, string> = {
        department: 'Department',
        title: 'Title',
        telephoneNumber: 'Phone',
        email: 'Email',
        description: 'Description',
        manager: 'Manager',
      };
      const columnFor: Record<string, string> = {
        department: 'DEPARTMENT',
        title: 'TITLE',
        telephoneNumber: 'TELEPHONE_NUMBER',
        email: 'EMAIL_ADDRESS',
        description: 'DESCRIPTION',
        manager: 'MANAGER',
      };
      const preview: DirectoryActionPreview = {
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Edit account',
        tone: 'neutral',
        title: `Edit ${displayName}`,
        subtitle: `${instanceName} · ${domainName}`,
        person: { name: displayName, detail: `${samAccountName} · ${domainName}` },
        fields: [
          ...(args.templateName ? [{ label: 'Reapply template', value: str(args.templateName) }] : []),
          ...changed.map(([argKey]) => ({
            label: fieldLabels[argKey],
            value: str(args[argKey]),
            oldValue: str(existing.user[columnFor[argKey]]) || '(none)',
          })),
        ],
        confirmTool: 'admanager_update_user_confirm',
        confirmLabel: 'Save changes',
        confirmArgs: args,
      };
      return {
        content: [{ type: 'text' as const, text: 'A card is shown for the user to confirm or cancel.' }],
        structuredContent: preview,
      };
    }
  );

  gated('accounts.edit').registerTool(
    'admanager_update_user_confirm',
    {
      title: 'ADManager Plus · Act — Execute confirmed user edits',
      description:
        'Apply the changes the user confirmed on the preview card. ' +
        confirmGuard('admanager_update_user_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: updateUserSchema,
    },
    updateUserHandler
  );

  // -------------------------------------------------------------------
  // Group membership — additive verbs only; see docs/admanager-connector-design.md.
  // -------------------------------------------------------------------

  const groupNamesField = z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .describe('Security group names (not distinguished names), e.g. "Finance-ReadOnly".');

  const groupTemplateNameField = z
    .string()
    .optional()
    .describe('An ADManager Plus template to apply for this change, by name, if this instance requires one.');

  const addGroupsSchema = z.object({
    instanceId: instanceIdField,
    domainName: domainField,
    samAccountName: samField,
    groupNames: groupNamesField,
    templateName: groupTemplateNameField,
  });

  const addGroupsHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const instanceId = str(args.instanceId);
    const refusal = await exposureRefusal(instanceId, 'groups.modify');
    if (refusal) return errText(refusal);
    const samAccountName = str(args.samAccountName);
    const domainName = str(args.domainName);
    const groupNames = dedupeGroupNames(toStringArray(args.groupNames));
    const templateName = str(args.templateName);
    const answered = await call(instanceId, 'add the user to groups', {
      method: 'PATCH',
      path: '/api/v2/users',
      query: { domain: domainName, filter: filterClause('SAM_ACCOUNT_NAME', 'eq', samAccountName) },
      body: {
        ...(templateName ? { template: { template_name: templateName } } : {}),
        data: { attributes: { memberOf: groupNames.join(';') } },
      },
    });
    if (!answered.ok) return errText(answered.message);
    const outcome = interpretV2PatchResponse(parseJson(answered.response.body));
    if (!outcome.ok) {
      return errText(`ADManager Plus could not add ${samAccountName} to groups: ${outcome.message}`);
    }
    return textResult(`Added ${samAccountName} to: ${groupNames.join(', ')}.`);
  };

  gated('groups.modify').registerTool(
    'admanager_add_user_to_groups_preview',
    {
      title: 'ADManager Plus · Act — Preview adding a user to groups',
      description:
        'Show the user an interactive card to confirm or cancel adding an AD account to one or ' +
        'more security groups. Purely additive — existing group membership is untouched.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: addGroupsSchema,
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'groups.modify');
      if (refusal) return errText(refusal);
      const samAccountName = str(args.samAccountName);
      const domainName = str(args.domainName);
      const requested = dedupeGroupNames(toStringArray(args.groupNames));
      const existing = await getUserRecord(instanceId, domainName, samAccountName, [
        'DISPLAY_NAME',
        'MEMBER_OF',
      ]);
      if (!existing.ok) return errText(existing.message);
      const current = groupNamesFromDns(toStringArray(existing.user.MEMBER_OF));
      const already = groupsPresent(requested, current);
      const instanceName = await instanceNameFor(instanceId);
      const displayName = str(existing.user.DISPLAY_NAME) || samAccountName;
      const preview: DirectoryActionPreview = {
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Add to groups',
        tone: 'positive',
        title: `Add ${displayName} to groups`,
        subtitle: `${instanceName} · ${domainName}`,
        person: { name: displayName, detail: `${samAccountName} · ${domainName}` },
        groupLists: [
          { label: 'Groups to add', groups: requested, tone: 'add' },
          ...(already.length ? [{ label: 'Already a member of', groups: already, tone: 'muted' as const }] : []),
        ],
        confirmTool: 'admanager_add_user_to_groups_confirm',
        confirmLabel: 'Add to groups',
        confirmArgs: { ...args, groupNames: requested },
      };
      return {
        content: [{ type: 'text' as const, text: 'A card is shown for the user to confirm or cancel.' }],
        structuredContent: preview,
      };
    }
  );

  gated('groups.modify').registerTool(
    'admanager_add_user_to_groups_confirm',
    {
      title: 'ADManager Plus · Act — Execute confirmed group additions',
      description:
        'Add the user to the groups confirmed on the preview card. Also the execution step for ' +
        'admanager_copy_group_membership_preview. ' +
        confirmGuard('admanager_add_user_to_groups_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: addGroupsSchema,
    },
    addGroupsHandler
  );

  const removeGroupsSchema = z.object({
    instanceId: instanceIdField,
    domainName: domainField,
    samAccountName: samField,
    groupNames: groupNamesField,
    templateName: groupTemplateNameField,
  });

  const removeGroupsHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const instanceId = str(args.instanceId);
    const refusal = await exposureRefusal(instanceId, 'groups.modify');
    if (refusal) return errText(refusal);
    const samAccountName = str(args.samAccountName);
    const domainName = str(args.domainName);
    const groupNames = dedupeGroupNames(toStringArray(args.groupNames));
    const templateName = str(args.templateName);
    const answered = await call(instanceId, 'remove the user from groups', {
      method: 'PATCH',
      path: '/api/v2/users',
      query: { domain: domainName, filter: filterClause('SAM_ACCOUNT_NAME', 'eq', samAccountName) },
      body: {
        ...(templateName ? { template: { template_name: templateName } } : {}),
        data: { attributes: { removememberOf: groupNames.join(';') } },
      },
    });
    if (!answered.ok) return errText(answered.message);
    const outcome = interpretV2PatchResponse(parseJson(answered.response.body));
    if (!outcome.ok) {
      return errText(`ADManager Plus could not remove ${samAccountName} from groups: ${outcome.message}`);
    }
    return textResult(`Removed ${samAccountName} from: ${groupNames.join(', ')}.`);
  };

  gated('groups.modify').registerTool(
    'admanager_remove_user_from_groups_preview',
    {
      title: 'ADManager Plus · Act — Preview removing a user from groups',
      description:
        'Show the user an interactive card to confirm or cancel removing an AD account from one ' +
        'or more security groups. Only the groups the account actually belongs to are offered for ' +
        'removal.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: removeGroupsSchema,
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'groups.modify');
      if (refusal) return errText(refusal);
      const samAccountName = str(args.samAccountName);
      const domainName = str(args.domainName);
      const requested = dedupeGroupNames(toStringArray(args.groupNames));
      const existing = await getUserRecord(instanceId, domainName, samAccountName, [
        'DISPLAY_NAME',
        'MEMBER_OF',
      ]);
      if (!existing.ok) return errText(existing.message);
      const current = groupNamesFromDns(toStringArray(existing.user.MEMBER_OF));
      const toRemove = groupsPresent(requested, current);
      const displayName = str(existing.user.DISPLAY_NAME) || samAccountName;
      if (toRemove.length === 0) {
        return textResult(
          `${displayName} is not a member of any of: ${requested.join(', ')}. Nothing to do.`
        );
      }
      const notAMember = requested.filter((name) => !toRemove.includes(name));
      const instanceName = await instanceNameFor(instanceId);
      const preview: DirectoryActionPreview = {
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Remove from groups',
        tone: 'caution',
        title: `Remove ${displayName} from groups`,
        subtitle: `${instanceName} · ${domainName}`,
        person: { name: displayName, detail: `${samAccountName} · ${domainName}` },
        groupLists: [
          { label: 'Groups to remove', groups: toRemove, tone: 'remove' },
          ...(notAMember.length
            ? [{ label: 'Not currently a member of (ignored)', groups: notAMember, tone: 'muted' as const }]
            : []),
        ],
        confirmTool: 'admanager_remove_user_from_groups_confirm',
        confirmLabel: 'Remove from groups',
        // Only the groups actually held are sent to confirm — never a
        // guess at a group the account was never in.
        confirmArgs: { ...args, groupNames: toRemove },
      };
      return {
        content: [{ type: 'text' as const, text: 'A card is shown for the user to confirm or cancel.' }],
        structuredContent: preview,
      };
    }
  );

  gated('groups.modify').registerTool(
    'admanager_remove_user_from_groups_confirm',
    {
      title: 'ADManager Plus · Act — Execute confirmed group removals',
      description:
        'Remove the user from the groups confirmed on the preview card. ' +
        confirmGuard('admanager_remove_user_from_groups_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: removeGroupsSchema,
    },
    removeGroupsHandler
  );

  // -------------------------------------------------------------------
  // Copy group membership from one user onto another (merge, never narrows).
  // -------------------------------------------------------------------

  gated('groups.modify').registerTool(
    'admanager_copy_group_membership_preview',
    {
      title: 'ADManager Plus · Act — Preview copying group membership',
      description:
        'Show the user an interactive card to confirm or cancel granting a target user every ' +
        'security group a source user has that the target doesn’t already — "give them the ' +
        'same access as their teammate." Never removes a group the target already has; the source ' +
        'user’s membership is read-only here.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: z.object({
        instanceId: instanceIdField,
        domainName: domainField,
        sourceSamAccountName: samField.describe('Logon name of the user whose groups to copy from.'),
        targetSamAccountName: samField.describe('Logon name of the user to grant those groups to.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'groups.modify');
      if (refusal) return errText(refusal);
      const domainName = str(args.domainName);
      const sourceSam = str(args.sourceSamAccountName);
      const targetSam = str(args.targetSamAccountName);
      if (sourceSam.toLowerCase() === targetSam.toLowerCase()) {
        return errText('The source and target accounts are the same.');
      }
      const [source, target] = await Promise.all([
        getUserRecord(instanceId, domainName, sourceSam, ['DISPLAY_NAME', 'MEMBER_OF']),
        getUserRecord(instanceId, domainName, targetSam, ['DISPLAY_NAME', 'MEMBER_OF']),
      ]);
      if (!source.ok) return errText(source.message);
      if (!target.ok) return errText(target.message);
      const sourceGroups = groupNamesFromDns(toStringArray(source.user.MEMBER_OF));
      const targetGroups = groupNamesFromDns(toStringArray(target.user.MEMBER_OF));
      const toAdd = groupsToAdd(sourceGroups, targetGroups);
      const sourceDisplayName = str(source.user.DISPLAY_NAME) || sourceSam;
      const targetDisplayName = str(target.user.DISPLAY_NAME) || targetSam;
      if (toAdd.length === 0) {
        return textResult(`${targetDisplayName} already has every group ${sourceDisplayName} has.`);
      }
      const instanceName = await instanceNameFor(instanceId);
      const preview: DirectoryActionPreview = {
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Copy group membership',
        tone: 'neutral',
        title: `Copy groups from ${sourceDisplayName} to ${targetDisplayName}`,
        subtitle: `${instanceName} · ${domainName}`,
        person: { name: targetDisplayName, detail: `${targetSam} · ${domainName}` },
        secondaryPerson: {
          label: 'Copying groups from',
          name: sourceDisplayName,
          detail: sourceSam,
        },
        groupLists: [{ label: 'Groups to add', groups: toAdd, tone: 'add' }],
        // Reuses the add-groups confirm tool directly: by the time a
        // human clicks confirm, this is exactly an "add these groups to
        // this user" action with the list already resolved.
        confirmTool: 'admanager_add_user_to_groups_confirm',
        confirmLabel: 'Copy groups',
        confirmArgs: {
          instanceId,
          domainName,
          samAccountName: targetSam,
          groupNames: toAdd,
        },
      };
      return {
        content: [{ type: 'text' as const, text: 'A card is shown for the user to confirm or cancel.' }],
        structuredContent: preview,
      };
    }
  );
}
