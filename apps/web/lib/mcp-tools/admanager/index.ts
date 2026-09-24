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
 * Every write here is preview + confirm on the shared issue-preview card,
 * whatever permission gates it — a deliberately wider net than Mirth's
 * "only permanent operations" rule, because these are identity/access
 * actions against a real employee's account with no version history to
 * catch a model's mistake after the fact.
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
import { APP_ONLY_META, ISSUE_PREVIEW_URI, confirmGuard, newPreviewId, previewToolMeta } from '../widgets';
import { NO_SUCH_INSTANCE } from './admanager-auth';
import type { AdManagerAuth } from './admanager-auth';

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

/** The per-item status_message ADManager Plus's v2 write endpoints report, when present. */
function itemStatusMessages(parsed: unknown): string[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) return [];
  const messages: string[] = [];
  for (const item of parsed.data) {
    if (isRecord(item) && isRecord(item.status) && typeof item.status.status_message === 'string') {
      messages.push(item.status.status_message);
    }
  }
  return messages;
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
    const answered = await call(instanceId, 'unlock the account', {
      method: 'POST',
      path: '/api/v1/user/unlockUserAccount',
      body: { domainName: str(args.domainName), userName: str(args.samAccountName) },
    });
    return answered.ok
      ? textResult(`Unlocked ${str(args.samAccountName)} in ${str(args.domainName)}.`)
      : errText(answered.message);
  };

  gated('accounts.unlock').registerTool(
    'admanager_unlock_account_preview',
    {
      title: 'ADManager Plus · Act — Preview unlocking an account',
      description:
        'Show the user an interactive card to confirm or cancel unlocking a locked-out AD account. ' +
        'This is the only way to unlock an account here — the user decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
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
      return {
        content: [{ type: 'text' as const, text: 'A card is shown for the user to confirm or cancel.' }],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: `Unlock ${str(existing.user.DISPLAY_NAME) || samAccountName}`,
          subtitle: `${instanceName} · ${domainName}`,
          confirmTool: 'admanager_unlock_account_confirm',
          confirmLabel: 'Unlock account',
          confirmArgs: args,
          fields: [
            { label: 'Instance', value: instanceName },
            { label: 'Domain', value: domainName },
            { label: 'User', value: `${str(existing.user.DISPLAY_NAME)} (${samAccountName})` },
            { label: 'Current status', value: str(existing.user.ACCOUNT_STATUS) || 'unknown' },
          ],
        },
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
  });

  const resetPasswordHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const instanceId = str(args.instanceId);
    const refusal = await exposureRefusal(instanceId, 'accounts.reset_password');
    if (refusal) return errText(refusal);
    const newPassword = str(args.newPassword) || generatePassword();
    const answered = await call(instanceId, 'reset the password', {
      method: 'POST',
      path: '/api/v1/user/resetPassword',
      body: {
        domainName: str(args.domainName),
        userName: str(args.samAccountName),
        newPassword,
        mustChangePassword: args.mustChangePassword !== false,
      },
    });
    return answered.ok
      ? textResult(
          `Password reset for ${str(args.samAccountName)} in ${str(args.domainName)}. New password: ${newPassword}`
        )
      : errText(answered.message);
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
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: resetPasswordSchema,
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'accounts.reset_password');
      if (refusal) return errText(refusal);
      const samAccountName = str(args.samAccountName);
      const domainName = str(args.domainName);
      const existing = await getUserRecord(instanceId, domainName, samAccountName, ['DISPLAY_NAME']);
      if (!existing.ok) return errText(existing.message);
      const newPassword = str(args.newPassword) || generatePassword();
      const mustChangePassword = args.mustChangePassword !== false;
      const instanceName = await instanceNameFor(instanceId);
      // The password is resolved HERE and carried in confirmArgs, so confirm
      // uses exactly what the human sees on the card — never regenerated.
      const confirmArgs = { ...args, newPassword, mustChangePassword };
      return {
        content: [{ type: 'text' as const, text: 'A card is shown for the user to confirm or cancel.' }],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: `Reset password for ${str(existing.user.DISPLAY_NAME) || samAccountName}`,
          subtitle: `${instanceName} · ${domainName}`,
          confirmTool: 'admanager_reset_password_confirm',
          confirmLabel: 'Reset password',
          confirmArgs,
          fields: [
            { label: 'Instance', value: instanceName },
            { label: 'Domain', value: domainName },
            { label: 'User', value: `${str(existing.user.DISPLAY_NAME)} (${samAccountName})` },
            { label: 'New password', value: newPassword },
            { label: 'Must change at next logon', value: mustChangePassword ? 'Yes' : 'No' },
          ],
        },
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

  function createUserBody(args: Record<string, unknown>, password: string): Record<string, unknown> {
    const attributes: Record<string, unknown> = {
      sAMAccountName: str(args.sAMAccountName),
      givenName: str(args.firstName),
      sn: str(args.lastName),
      name: `${str(args.firstName)} ${str(args.lastName)}`.trim(),
      userPrincipalName: str(args.userPrincipalName),
      OUName: str(args.ouPath),
    };
    if (args.email) attributes.mail = str(args.email);
    if (args.department) attributes.department = str(args.department);
    if (args.title) attributes.title = str(args.title);
    if (args.telephoneNumber) attributes.telephoneNumber = str(args.telephoneNumber);

    const templateName = str(args.templateName);
    return {
      data: [
        {
          ...(templateName ? { template: { template_name: templateName } } : {}),
          attributes,
          password,
          enabled: args.enabled !== false,
        },
      ],
    };
  }

  const createUserHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const instanceId = str(args.instanceId);
    const refusal = await exposureRefusal(instanceId, 'accounts.create');
    if (refusal) return errText(refusal);
    const password = str(args.password) || generatePassword();
    const answered = await call(instanceId, 'create the user', {
      method: 'POST',
      path: '/api/v2/users',
      query: { domain: str(args.domainName) },
      body: createUserBody(args, password),
    });
    if (!answered.ok) return errText(answered.message);
    const messages = itemStatusMessages(parseJson(answered.response.body));
    return textResult(
      [
        `Created ${str(args.sAMAccountName)} in ${str(args.domainName)}. Password: ${password}`,
        ...messages,
      ].join('\n')
    );
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
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: createUserSchema,
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'accounts.create');
      if (refusal) return errText(refusal);
      const password = str(args.password) || generatePassword();
      const instanceName = await instanceNameFor(instanceId);
      const confirmArgs = { ...args, password };
      return {
        content: [{ type: 'text' as const, text: 'A card is shown for the user to confirm or cancel.' }],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: `Create ${str(args.firstName)} ${str(args.lastName)}`,
          subtitle: `${instanceName} · ${str(args.domainName)}`,
          confirmTool: 'admanager_create_user_confirm',
          confirmLabel: 'Create account',
          confirmArgs,
          fields: [
            { label: 'Instance', value: instanceName },
            { label: 'Domain', value: str(args.domainName) },
            { label: 'OU', value: str(args.ouPath) },
            { label: 'Name', value: `${str(args.firstName)} ${str(args.lastName)}` },
            { label: 'Logon name', value: str(args.sAMAccountName) },
            { label: 'UPN', value: str(args.userPrincipalName) },
            ...(args.email ? [{ label: 'Email', value: str(args.email) }] : []),
            ...(args.department ? [{ label: 'Department', value: str(args.department) }] : []),
            ...(args.title ? [{ label: 'Title', value: str(args.title) }] : []),
            ...(args.templateName ? [{ label: 'Template', value: str(args.templateName) }] : []),
            { label: 'Initial password', value: password },
            { label: 'Enabled', value: args.enabled === false ? 'No' : 'Yes' },
          ],
        },
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
    const messages = itemStatusMessages(parseJson(answered.response.body));
    return textResult([`Updated ${samAccountName} in ${domainName}.`, ...messages].join('\n'));
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
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
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
      return {
        content: [{ type: 'text' as const, text: 'A card is shown for the user to confirm or cancel.' }],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: `Edit ${str(existing.user.DISPLAY_NAME) || samAccountName}`,
          subtitle: `${instanceName} · ${domainName}`,
          confirmTool: 'admanager_update_user_confirm',
          confirmLabel: 'Save changes',
          confirmArgs: args,
          fields: [
            { label: 'Instance', value: instanceName },
            { label: 'User', value: `${str(existing.user.DISPLAY_NAME)} (${samAccountName})` },
            ...(args.templateName ? [{ label: 'Reapply template', value: str(args.templateName) }] : []),
            ...changed.map(([argKey]) => ({
              label: fieldLabels[argKey],
              value: `${str(existing.user[columnFor[argKey]]) || '(none)'} → ${str(args[argKey])}`,
            })),
          ],
        },
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

  const addGroupsSchema = z.object({
    instanceId: instanceIdField,
    domainName: domainField,
    samAccountName: samField,
    groupNames: groupNamesField,
  });

  const addGroupsHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const instanceId = str(args.instanceId);
    const refusal = await exposureRefusal(instanceId, 'groups.modify');
    if (refusal) return errText(refusal);
    const groupNames = dedupeGroupNames(toStringArray(args.groupNames));
    const answered = await call(instanceId, 'add the user to groups', {
      method: 'POST',
      path: '/api/v1/user/addUsersToGroups',
      body: {
        domainName: str(args.domainName),
        userNames: [str(args.samAccountName)],
        groupNames,
      },
    });
    return answered.ok
      ? textResult(`Added ${str(args.samAccountName)} to: ${groupNames.join(', ')}.`)
      : errText(answered.message);
  };

  gated('groups.modify').registerTool(
    'admanager_add_user_to_groups_preview',
    {
      title: 'ADManager Plus · Act — Preview adding a user to groups',
      description:
        'Show the user an interactive card to confirm or cancel adding an AD account to one or ' +
        'more security groups. Purely additive — existing group membership is untouched.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
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
      return {
        content: [{ type: 'text' as const, text: 'A card is shown for the user to confirm or cancel.' }],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: `Add ${str(existing.user.DISPLAY_NAME) || samAccountName} to groups`,
          subtitle: `${instanceName} · ${domainName}`,
          confirmTool: 'admanager_add_user_to_groups_confirm',
          confirmLabel: 'Add to groups',
          confirmArgs: { ...args, groupNames: requested },
          fields: [
            { label: 'Instance', value: instanceName },
            { label: 'User', value: `${str(existing.user.DISPLAY_NAME)} (${samAccountName})` },
            { label: 'Groups to add', value: requested.join(', ') },
            ...(already.length
              ? [{ label: 'Already a member of', value: already.join(', ') }]
              : []),
          ],
        },
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
  });

  const removeGroupsHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const instanceId = str(args.instanceId);
    const refusal = await exposureRefusal(instanceId, 'groups.modify');
    if (refusal) return errText(refusal);
    const groupNames = dedupeGroupNames(toStringArray(args.groupNames));
    const answered = await call(instanceId, 'remove the user from groups', {
      method: 'POST',
      path: '/api/v1/user/removeUsersFromGroups',
      body: {
        domainName: str(args.domainName),
        userNames: [str(args.samAccountName)],
        groupNames,
      },
    });
    return answered.ok
      ? textResult(`Removed ${str(args.samAccountName)} from: ${groupNames.join(', ')}.`)
      : errText(answered.message);
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
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
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
      if (toRemove.length === 0) {
        return textResult(
          `${str(existing.user.DISPLAY_NAME) || samAccountName} is not a member of any of: ${requested.join(', ')}. Nothing to do.`
        );
      }
      const notAMember = requested.filter((name) => !toRemove.includes(name));
      const instanceName = await instanceNameFor(instanceId);
      return {
        content: [{ type: 'text' as const, text: 'A card is shown for the user to confirm or cancel.' }],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: `Remove ${str(existing.user.DISPLAY_NAME) || samAccountName} from groups`,
          subtitle: `${instanceName} · ${domainName}`,
          confirmTool: 'admanager_remove_user_from_groups_confirm',
          confirmLabel: 'Remove from groups',
          // Only the groups actually held are sent to confirm — never a
          // guess at a group the account was never in.
          confirmArgs: { ...args, groupNames: toRemove },
          fields: [
            { label: 'Instance', value: instanceName },
            { label: 'User', value: `${str(existing.user.DISPLAY_NAME)} (${samAccountName})` },
            { label: 'Groups to remove', value: toRemove.join(', ') },
            ...(notAMember.length
              ? [{ label: 'Not currently a member of (ignored)', value: notAMember.join(', ') }]
              : []),
          ],
        },
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
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
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
      if (toAdd.length === 0) {
        return textResult(
          `${str(target.user.DISPLAY_NAME) || targetSam} already has every group ${str(source.user.DISPLAY_NAME) || sourceSam} has.`
        );
      }
      const instanceName = await instanceNameFor(instanceId);
      return {
        content: [{ type: 'text' as const, text: 'A card is shown for the user to confirm or cancel.' }],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: `Copy groups from ${str(source.user.DISPLAY_NAME) || sourceSam} to ${str(target.user.DISPLAY_NAME) || targetSam}`,
          subtitle: `${instanceName} · ${domainName}`,
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
          fields: [
            { label: 'Instance', value: instanceName },
            { label: 'From', value: `${str(source.user.DISPLAY_NAME)} (${sourceSam})` },
            { label: 'To', value: `${str(target.user.DISPLAY_NAME)} (${targetSam})` },
            { label: 'Groups to add', value: toAdd.join(', ') },
          ],
        },
      };
    }
  );
}
