/**
 * The mirth_* tools — operator-registered Mirth Connect (NextGen Connect
 * 4.5.2) servers each person connects with their OWN Mirth account
 * (Connectors page). An org runs several (dev, test, prod…), so every tool
 * takes the `instanceId` that mirth_list_instances reports. The Mirth
 * server is the sole authorization authority: every operation crosses the
 * authenticated seam to apps/worker-mirth, which logs in as the caller's
 * stored account and lets Mirth judge the request.
 *
 * What this layer enforces is the person's PERMISSIONS, stored on the
 * connection row (packages/connector-mirth/src/permissions.ts): named
 * grants a person recognises — read channels, deploy channels, delete
 * messages, restore the server… Every tool names one; it registers when
 * the caller holds it on some connected instance and re-checks it on the
 * instance named, per call. Permissions can hide access the person holds;
 * they can never mint any — which is why they are checked here and
 * deliberately not in the worker.
 *
 * Coverage: the whole REST API, every route a named tool with its own
 * validated arguments. The curated tools below phrase the everyday
 * operations (channels, deployment, statuses, statistics, messages,
 * events, alerts, code templates, configuration, users, extensions) and
 * unwrap Mirth's wire format into readable lines; every other route is
 * generated from the operation table in @renkei/connector-mirth by
 * operations.ts — one `mirth_<operation>` tool each, with the route's own
 * path, query and body fields as its schema, sharing this file's call
 * path and exposure gate. Nothing on the server is out of reach, and
 * nothing bypasses the gate.
 *
 * Permanent operations (delete a channel, purge messages, restore the
 * server…) are additionally preview + confirm on a card, whatever the
 * permission says: a human click sits between the model and the act.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  isRecord,
  mirthPermission,
  textOf,
  toMirthDate,
  unwrapList,
  unwrapMap,
} from '@renkei/connector-mirth';
import type { ConnectedInstance, MirthPermission } from '@renkei/connector-mirth';
import type { MCPToolContext } from '../common';
import { mirthApi } from '@/lib/mirth/service-client';
import type {
  MirthApiRequest,
  MirthClientError,
  MirthTarget,
  WireApiResponse,
} from '@/lib/mirth/service-client';
import {
  APP_ONLY_META,
  ISSUE_PREVIEW_URI,
  confirmGuard,
  newPreviewId,
  previewToolMeta,
} from '../widgets';
import { NO_SUCH_INSTANCE } from './mirth-auth';
import type { MirthAuth } from './mirth-auth';
import { registerOperationTools, type OperationRuntime } from './operations';
import {
  REF_KINDS,
  createDirectory,
  isRefKind,
  resolveRef,
  withReferenceResolution,
  type Directory,
  type RefKind,
} from './resolve';

/** The connector key the Mirth capabilities register under. */
export const MIRTH_MCP_CONNECTOR = 'mirth';

/** What the caller may do somewhere: the union of their instances' permissions. */
export interface MirthToolExposure {
  permissions: readonly string[];
}

const DEFAULT_MAX_CHARS = 60_000;
/** Bulk channel operations run one request per id; keep the fan-out honest. */
const MAX_BULK_CHANNELS = 50;

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

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated at ${maxChars} of ${text.length} characters]`;
}

/** "channels: read, deploy; messages: read" — the permissions, grouped by area. */
function permissionSummary(permissions: readonly MirthPermission[]): string {
  if (permissions.length === 0) return 'none';
  const byArea = new Map<string, string[]>();
  for (const id of permissions) {
    const [area, verb] = id.split('.');
    const list = byArea.get(area) ?? [];
    list.push(verb);
    byArea.set(area, list);
  }
  return [...byArea.entries()]
    .map(([area, verbs]) => `${area.replace('_', ' ')}: ${verbs.join(', ')}`)
    .join('; ');
}

function instanceLine(connected: ConnectedInstance): string {
  return (
    `${connected.instance.name} [${connected.instance.environment}] — id ${connected.instance.id} — ` +
    `${connected.instance.baseUrl} — connected as ${connected.connection.username} — permissions: ` +
    permissionSummary(connected.connection.permissions)
  );
}

/**
 * Phrase a worker refusal or failure for the model. The worker's own
 * messages pass through — they are written user-facing at the source.
 */
function clientMessage(what: string, error: MirthClientError): string {
  if (error.kind === 'unconfigured') {
    return 'Mirth Connect is unavailable: the Mirth service is not configured on this deployment.';
  }
  if (error.kind === 'unreachable') {
    return `Could not reach the Mirth service to ${what}.`;
  }
  switch (error.type) {
    case 'no_instance':
    case 'not_connected':
      // One answer for "no such instance" and "not yours": ids must not
      // become an existence oracle for instances others connected.
      return NO_SUCH_INSTANCE;
    case 'login_failed':
      return 'The Mirth server rejected your stored credentials — reconnect the instance on the Connectors page.';
    case 'bad_credentials':
      return 'Your stored credentials for this instance cannot be read — reconnect it on the Connectors page.';
    case 'store':
      return 'Could not read your Mirth connections.';
    case 'timeout':
      return `The Mirth server did not answer in time trying to ${what}.`;
    case 'unreachable':
      return `Could not reach the Mirth server to ${what}: ${error.message ?? 'no route'}.`;
    case 'too_large':
      return `The Mirth server's answer was too large to ${what} here — narrow the request.`;
    default:
      return `Could not ${what}: ${error.message ?? error.type}.`;
  }
}

/** Phrase a non-2xx answer from Mirth itself. */
function upstreamMessage(what: string, response: WireApiResponse): string {
  const excerpt = clip(response.body.replace(/\s+/g, ' ').trim(), 400);
  switch (response.status) {
    case 401:
      return `Mirth would not authenticate the request to ${what} — reconnect the instance on the Connectors page.`;
    case 403:
      return `Mirth refused to ${what}: your Mirth account does not have permission for it.`;
    case 404:
      return `Mirth has nothing at that id or path (could not ${what}).`;
    default:
      return `Mirth answered ${response.status} trying to ${what}${excerpt ? `: ${excerpt}` : '.'}`;
  }
}

function parseJson(body: string): unknown {
  if (!body.trim()) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** A short table line from a channel dashboard status. */
function statusLine(status: Record<string, unknown>): string {
  const stats = isRecord(status.statistics) ? unwrapMap(status.statistics) : {};
  const counts = ['RECEIVED', 'FILTERED', 'QUEUED', 'SENT', 'ERROR']
    .filter((key) => key in stats)
    .map((key) => `${key.toLowerCase()} ${textOf(stats[key])}`)
    .join(', ');
  return (
    `${str(status.name)} — id ${str(status.channelId)} — ${str(status.state) || 'UNKNOWN'}` +
    (status.deployedRevisionDelta !== undefined && Number(status.deployedRevisionDelta) > 0
      ? ` — ${textOf(status.deployedRevisionDelta)} undeployed revision(s)`
      : '') +
    (counts ? ` — ${counts}` : '')
  );
}

function dateOf(value: unknown): string {
  // Mirth serializes Calendars as {"time": epochMillis, "timezone": "..."}.
  if (isRecord(value) && typeof value.time === 'number') return new Date(value.time).toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return str(value);
}

/** Query values a model may pass, dropped when empty. */
type QueryValue = string | number | boolean | string[] | undefined;
function queryOf(
  values: Record<string, QueryValue>
): Record<string, string | number | boolean | string[]> {
  const query: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    query[key] = value;
  }
  return query;
}

/** Looking names up reveals what exists, so a lookup needs that area's read permission. */
const READ_PERMISSION_FOR_KIND: Record<RefKind, MirthPermission> = {
  channel: 'channels.read',
  channel_group: 'channels.read',
  channel_tag: 'channels.read',
  connector: 'channels.read',
  alert: 'alerts.read',
  code_template: 'code_templates.read',
  code_template_library: 'code_templates.read',
  user: 'users.read',
  resource: 'server.read',
  database_task: 'server.read',
};

const instanceIdField = z
  .string()
  .min(1)
  .describe(
    "From mirth_list_instances: the instance's id, its name, or its environment label (when " +
      'only one instance carries it).'
  );
const channelIdField = z
  .string()
  .min(1)
  .describe('The channel id or its name (from mirth_list_channels).');
/** A connector of the channel the same call names: its metaDataId (0 = source) or its name. */
const connectorField = z
  .union([z.number().int().nonnegative(), z.string().min(1)])
  .describe('A connector metaDataId (0 = source, 1.. = destinations) or its name.');

/**
 * A date argument: any ISO 8601 date-time a model writes, checked here and
 * sent to Mirth in the one Calendar form it parses (toMirthDate).
 */
const dateField = (description: string) =>
  z
    .string()
    .refine((value) => toMirthDate(value) !== undefined, 'Expected an ISO 8601 date-time.')
    .optional()
    .describe(`${description} ISO 8601 date-time (e.g. 2026-09-01T00:00:00Z).`);
/** The Mirth form of a validated date argument, or undefined when it was not given. */
const dateArg = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? toMirthDate(value) : undefined;

/** The message search filters Mirth's GET /channels/{id}/messages accepts, as a model sees them. */
const messageFilterFields = {
  minMessageId: z.number().int().optional(),
  maxMessageId: z.number().int().optional(),
  startDate: dateField('Received on or after.'),
  endDate: dateField('Received on or before.'),
  status: z
    .array(z.enum(['RECEIVED', 'FILTERED', 'TRANSFORMED', 'SENT', 'QUEUED', 'ERROR', 'PENDING']))
    .optional()
    .describe('Connector-message statuses to match.'),
  textSearch: z.string().optional().describe('Free text searched across message content.'),
  includedMetaDataId: z
    .array(z.number().int())
    .optional()
    .describe('Connector metadata ids to include (0 = source, 1.. = destinations).'),
  error: z.boolean().optional().describe('Only messages with an error.'),
};

function messageQuery(
  args: Record<string, unknown>
): Record<string, string | number | boolean | string[]> {
  return queryOf({
    minMessageId: typeof args.minMessageId === 'number' ? args.minMessageId : undefined,
    maxMessageId: typeof args.maxMessageId === 'number' ? args.maxMessageId : undefined,
    startDate: dateArg(args.startDate),
    endDate: dateArg(args.endDate),
    status: Array.isArray(args.status) ? args.status.map(String) : undefined,
    textSearch: str(args.textSearch) || undefined,
    includedMetaDataId: Array.isArray(args.includedMetaDataId)
      ? args.includedMetaDataId.map(String)
      : undefined,
    error: typeof args.error === 'boolean' ? args.error : undefined,
  });
}

export function registerMirthTools(
  rawServer: McpServer,
  _context: MCPToolContext,
  auth: MirthAuth,
  exposure: MirthToolExposure,
  options: { directory?: Directory } = {}
): void {
  /**
   * The per-call exposure gate for act tools: the caller's own connection,
   * read fresh, must expose the needed family on THIS instance. An
   * instance the caller never connected answers the shared not-connected
   * refusal.
   */
  const exposureRefusal = async (
    instanceId: string,
    permission: MirthPermission
  ): Promise<string | null> => {
    const connection = await auth.connection(instanceId);
    if (typeof connection === 'string') return connection;
    if (connection.permissions.includes(permission)) return null;
    return (
      `"${mirthPermission(permission).label}" is not enabled for this Mirth instance — it can ` +
      'be enabled per instance on the Connectors page in Renkei.'
    );
  };

  /** What this caller holds on some connected instance: the registration gate. */
  const granted = new Set<string>(exposure.permissions);

  const targetFor = (instanceId: string): MirthTarget | string => {
    const target = auth.target();
    if (typeof target === 'string') return target;
    return { ...target, instanceId };
  };

  /** One call, with every failure already phrased. */
  const call = async (
    instanceId: string,
    what: string,
    request: MirthApiRequest,
    okStatuses: number[] = [200, 201, 204]
  ): Promise<{ ok: true; response: WireApiResponse } | { ok: false; message: string }> => {
    const target = targetFor(instanceId);
    if (typeof target === 'string') return { ok: false, message: target };
    const answered = await mirthApi(target, request);
    if (!answered.ok) return { ok: false, message: clientMessage(what, answered.err) };
    if (!okStatuses.includes(answered.val.status)) {
      return { ok: false, message: upstreamMessage(what, answered.val) };
    }
    return { ok: true, response: answered.val };
  };

  /**
   * Names ↔ ids (resolve.ts). Every tool registered on `server` below gets
   * its `instanceId` and reference arguments (channelId, alertId, metaDataId…)
   * resolved from a name before its handler runs, and a legend of the ids
   * its answer mentions after — so handlers only ever see ids.
   */
  const scope = auth.target();
  const directory =
    options.directory ??
    createDirectory(
      call,
      typeof scope === 'string' ? 'denied' : `${scope.tenantId}|${scope.subject}`
    );
  const server = withReferenceResolution(rawServer, {
    listConnected: () => auth.listConnected(),
    directory,
  });

  /**
   * A tool registers only when the caller holds its permission on some
   * connected instance — so the tool list tells the truth — and its
   * handler re-checks the permission on the instance named, per call.
   */
  const gated = (permission: MirthPermission): McpServer =>
    granted.has(permission)
      ? server
      : new Proxy(server, {
          get(target, property, receiver) {
            if (property === 'registerTool') return () => undefined;
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });

  const getJson = async (
    instanceId: string,
    what: string,
    path: string,
    query?: MirthApiRequest['query']
  ): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> => {
    const answered = await call(instanceId, what, { method: 'GET', path, query });
    if (!answered.ok) return answered;
    return { ok: true, value: parseJson(answered.response.body) };
  };

  /**
   * What the generated, one-tool-per-route half (operations.ts) borrows:
   * the same call path, the same exposure gate, the same instance names.
   */
  const runtime: OperationRuntime = {
    call,
    exposureRefusal,
    async instanceName(instanceId) {
      const connected = await auth.listConnected();
      if (typeof connected === 'string') return instanceId;
      return (
        connected.find((entry) => entry.instance.id === instanceId)?.instance.name ?? instanceId
      );
    },
    maxChars: DEFAULT_MAX_CHARS,
  };

  // -------------------------------------------------------------------
  // Read tools — registered for any connection.
  // -------------------------------------------------------------------

  server.registerTool(
    'mirth_list_instances',
    {
      title: 'Mirth · Read — List the Mirth Connect servers you connected',
      description:
        'The Mirth Connect (NextGen Connect) servers this user has connected with their own ' +
        'Mirth account — typically one per environment (dev, test, prod) — with what the tools ' +
        'may do on each (their choice on the Connectors page). Every other mirth_* tool takes ' +
        'the instanceId listed here. What each operation is actually allowed to do is decided ' +
        "by the Mirth server judging the user's own account.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}),
    },
    async () => {
      const connected = await auth.listConnected();
      if (typeof connected === 'string') return errText(connected);
      if (connected.length === 0) {
        return textResult(
          'No Mirth instances are connected. Instances are connected with your own Mirth ' +
            'account on the Connectors page in Renkei.'
        );
      }
      return textResult(
        `Mirth instances you can use:\n${connected.map((entry) => instanceLine(entry)).join('\n')}`
      );
    }
  );

  const refKindField = z
    .enum(REF_KINDS)
    .describe(
      'What the values are: channel, alert, user, code_template, connector (needs channelId)…'
    );

  server.registerTool(
    'mirth_resolve_ids',
    {
      title: 'Mirth · Read — Look up ids by name',
      description:
        'The id for each name given — channels, channel groups, tags, alerts, code templates ' +
        'and libraries, users, resources, database tasks, or the connectors of one channel. ' +
        'Every other mirth_* tool already accepts a name wherever it takes an id; this is for ' +
        'when the id itself is wanted (an XML document, a report). A name that is ambiguous ' +
        'lists the candidates rather than guessing.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        instanceId: instanceIdField,
        kind: refKindField,
        names: z.array(z.string().min(1)).min(1).max(200),
        channelId: channelIdField.optional().describe('For kind "connector": whose connectors.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      if (!isRefKind(args.kind)) return errText('kind is not one of the known reference kinds.');
      const kind = args.kind;
      const refusal = await exposureRefusal(instanceId, READ_PERMISSION_FOR_KIND[kind]);
      if (refusal) return errText(refusal);
      const names = Array.isArray(args.names) ? args.names.map(String) : [];
      const scope = kind === 'connector' ? { channelId: str(args.channelId) || undefined } : {};
      const lines: string[] = [];
      let failures = 0;
      for (const name of names) {
        const resolved = await resolveRef(directory, instanceId, kind, name, scope);
        if (resolved.ok)
          lines.push(
            `${name} = ${resolved.id}${resolved.name && resolved.name !== name ? ` (${resolved.name})` : ''}`
          );
        else {
          failures += 1;
          lines.push(`${name}: ${resolved.message}`);
        }
      }
      return failures === names.length ? errText(lines.join('\n')) : textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'mirth_resolve_names',
    {
      title: 'Mirth · Read — Look up names by id',
      description:
        'The human-readable name for each id given — channels, channel groups, tags, alerts, ' +
        'code templates and libraries, users, resources, database tasks, or the connectors of ' +
        'one channel (metaDataIds). Answers of other mirth_* tools already carry a legend for ' +
        'the ids they mention; this is for ids found elsewhere (a document, a log line).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        instanceId: instanceIdField,
        kind: refKindField,
        ids: z
          .array(z.union([z.string().min(1), z.number().int()]))
          .min(1)
          .max(200),
        channelId: channelIdField.optional().describe('For kind "connector": whose connectors.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      if (!isRefKind(args.kind)) return errText('kind is not one of the known reference kinds.');
      const kind = args.kind;
      const refusal = await exposureRefusal(instanceId, READ_PERMISSION_FOR_KIND[kind]);
      if (refusal) return errText(refusal);
      const scope = kind === 'connector' ? { channelId: str(args.channelId) || undefined } : {};
      const entries = await directory.entries(instanceId, kind, scope, true);
      if (typeof entries === 'string') return errText(entries);
      const byId = new Map(entries.map((entry) => [entry.id, entry.name]));
      const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
      const lines = ids.map(
        (id) => `${id} = ${byId.get(id) ?? '(no such ' + kind.replace(/_/g, ' ') + ')'}`
      );
      return textResult(lines.join('\n'));
    }
  );

  gated('server.read').registerTool(
    'mirth_server_info',
    {
      title: 'Mirth · Read — Server version and status',
      description:
        'Version, build date, server id, status, JVM and time zone of one Mirth instance ' +
        '(GET /server/about and /server/status).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ instanceId: instanceIdField }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const about = await getJson(instanceId, 'read the server info', '/server/about');
      if (!about.ok) return errText(about.message);
      const status = await call(instanceId, 'read the server status', {
        method: 'GET',
        path: '/server/status',
        accept: 'text/plain',
      });
      const map = unwrapMap(about.value);
      const lines = Object.entries(map).map(([key, value]) => `${key}: ${textOf(value)}`);
      if (status.ok) {
        const code = status.response.body.trim();
        lines.push(
          `status: ${code === '0' ? 'RUNNING' : code === '1' ? 'STARTING' : code === '2' ? 'STOPPING' : code}`
        );
      }
      return textResult(lines.join('\n') || 'Mirth answered with no server information.');
    }
  );

  gated('channels.read').registerTool(
    'mirth_list_channels',
    {
      title: 'Mirth · Read — List channels with their deployment state',
      description:
        'Every channel on an instance (deployed or not) with its id, dashboard state ' +
        '(STARTED, STOPPED, PAUSED, or UNDEPLOYED), undeployed-revision count and message ' +
        'counts. Filter by a name fragment to narrow.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        instanceId: instanceIdField,
        nameContains: z
          .string()
          .optional()
          .describe('Case-insensitive fragment of the channel name.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const names = await getJson(instanceId, 'list the channels', '/channels/idsAndNames');
      if (!names.ok) return errText(names.message);
      const statuses = await getJson(
        instanceId,
        'read the channel statuses',
        '/channels/statuses',
        {
          includeUndeployed: true,
        }
      );
      if (!statuses.ok) return errText(statuses.message);

      const byId = new Map<string, Record<string, unknown>>();
      for (const status of unwrapList(statuses.value)) {
        if (isRecord(status) && str(status.channelId)) byId.set(str(status.channelId), status);
      }
      const fragment = str(args.nameContains).toLowerCase();
      const lines: string[] = [];
      for (const [id, name] of Object.entries(unwrapMap(names.value))) {
        const label = textOf(name);
        if (fragment && !label.toLowerCase().includes(fragment)) continue;
        const status = byId.get(id);
        lines.push(
          status ? statusLine({ ...status, name: label }) : `${label} — id ${id} — UNDEPLOYED`
        );
      }
      if (lines.length === 0) {
        return textResult(
          fragment ? `No channel name contains "${fragment}".` : 'This instance has no channels.'
        );
      }
      return textResult(`${lines.length} channel(s):\n${lines.join('\n')}`);
    }
  );

  gated('channels.read').registerTool(
    'mirth_get_channel',
    {
      title: 'Mirth · Read — One channel definition',
      description:
        "A channel's definition: a readable summary (connectors, transports, script sizes), " +
        'the full JSON, or the XML exactly as the Mirth Administrator exports it (the form to ' +
        'edit and hand back to mirth_import_channel).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        instanceId: instanceIdField,
        channelId: channelIdField,
        format: z.enum(['summary', 'json', 'xml']).optional().describe('Default summary.'),
        maxChars: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Cap on returned characters (default 60000).'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const channelId = str(args.channelId);
      const format = str(args.format) || 'summary';
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : DEFAULT_MAX_CHARS;
      const answered = await call(instanceId, 'read the channel', {
        method: 'GET',
        path: `/channels/${encodeURIComponent(channelId)}`,
        accept: format === 'xml' ? 'application/xml' : 'application/json',
      });
      if (!answered.ok) return errText(answered.message);
      if (!answered.response.body.trim()) return errText('Mirth has no channel with that id.');
      if (format !== 'summary') return textResult(clip(answered.response.body, maxChars));

      const channel = parseJson(answered.response.body);
      const root = isRecord(channel) && isRecord(channel.channel) ? channel.channel : channel;
      if (!isRecord(root)) return textResult(clip(answered.response.body, maxChars));
      const source = isRecord(root.sourceConnector) ? root.sourceConnector : {};
      const destinations = isRecord(root.destinationConnectors)
        ? unwrapList(root.destinationConnectors)
        : [];
      const scriptSize = (value: unknown) =>
        typeof value === 'string' ? `${value.length} chars` : 'none';
      const lines = [
        `${str(root.name)} — id ${str(root.id)} — revision ${textOf(root.revision)}`,
        ...(str(root.description) ? [`Description: ${str(root.description)}`] : []),
        `Source: ${str(source.name) || 'sourceConnector'} (${str(source.transportName)}) — ` +
          `${isRecord(source.properties) ? Object.keys(source.properties).length : 0} properties, ` +
          `${isRecord(source.transformer) ? unwrapList(isRecord(source.transformer.elements) ? source.transformer.elements : []).length : 0} transformer step(s), ` +
          `${isRecord(source.filter) ? unwrapList(isRecord(source.filter.elements) ? source.filter.elements : []).length : 0} filter rule(s)`,
        `Destinations (${destinations.length}):`,
        ...destinations.map((destination) =>
          isRecord(destination)
            ? `  - ${str(destination.name)} (${str(destination.transportName)}) — metaDataId ${textOf(destination.metaDataId)} — ${destination.enabled === false || destination.enabled === 'false' ? 'disabled' : 'enabled'}`
            : '  - (unreadable destination)'
        ),
        `Scripts: preprocessing ${scriptSize(root.preprocessingScript)}, postprocessing ${scriptSize(root.postprocessingScript)}, deploy ${scriptSize(root.deployScript)}, undeploy ${scriptSize(root.undeployScript)}`,
        'Use format "xml" for the full definition as the Administrator exports it.',
      ];
      return textResult(clip(lines.join('\n'), maxChars));
    }
  );

  gated('channels.read').registerTool(
    'mirth_channel_status',
    {
      title: 'Mirth · Read — Dashboard status of one channel and its connectors',
      description:
        "One channel's dashboard status: state, deployed date and revision, statistics, and " +
        'the state of each connector (source and destinations).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ instanceId: instanceIdField, channelId: channelIdField }),
    },
    async (args: Record<string, unknown>) => {
      const status = await getJson(
        str(args.instanceId),
        'read the channel status',
        `/channels/${encodeURIComponent(str(args.channelId))}/status`
      );
      if (!status.ok) return errText(status.message);
      const root =
        isRecord(status.value) && isRecord(status.value.dashboardStatus)
          ? status.value.dashboardStatus
          : status.value;
      if (!isRecord(root) || !str(root.channelId)) {
        return errText('That channel is not deployed (no dashboard status), or does not exist.');
      }
      const lines = [
        statusLine(root),
        ...(root.deployedDate
          ? [
              `Deployed: ${dateOf(root.deployedDate)} (revision ${textOf(root.deployedRevisionDelta)} behind)`,
            ]
          : []),
        ...unwrapList(isRecord(root.childStatuses) ? root.childStatuses : []).map((child) =>
          isRecord(child)
            ? `  connector ${textOf(child.metaDataId)} ${str(child.name)} — ${str(child.state)}`
            : ''
        ),
      ].filter(Boolean);
      return textResult(lines.join('\n'));
    }
  );

  gated('channels.read').registerTool(
    'mirth_channel_statistics',
    {
      title: 'Mirth · Read — Message statistics per channel',
      description:
        'Received / filtered / queued / sent / errored counts for every channel, or the ones ' +
        'named. Per-connector detail is returned when a single channel is asked for.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        instanceId: instanceIdField,
        channelIds: z.array(z.string().min(1)).optional().describe('Omit for all channels.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const ids = Array.isArray(args.channelIds) ? args.channelIds.map(String) : [];
      if (ids.length === 1) {
        const one = await getJson(
          instanceId,
          'read the statistics',
          `/channels/${encodeURIComponent(ids[0])}/statistics`
        );
        if (!one.ok) return errText(one.message);
        return textResult(clip(JSON.stringify(one.value, null, 2), DEFAULT_MAX_CHARS));
      }
      const all = await getJson(instanceId, 'read the statistics', '/channels/statistics', {
        // Mirth reads the repeatable channel filter from the singular key.
        ...(ids.length ? { channelId: ids } : {}),
        includeUndeployed: true,
        aggregateStats: true,
      });
      if (!all.ok) return errText(all.message);
      const lines = unwrapList(all.value).map((entry) => {
        if (!isRecord(entry)) return '';
        return `${str(entry.channelId)} — received ${textOf(entry.received)}, filtered ${textOf(entry.filtered)}, queued ${textOf(entry.queued)}, sent ${textOf(entry.sent)}, error ${textOf(entry.error)}`;
      });
      return textResult(lines.filter(Boolean).join('\n') || 'No statistics were returned.');
    }
  );

  gated('channels.read').registerTool(
    'mirth_list_channel_groups',
    {
      title: 'Mirth · Read — Channel groups and tags',
      description:
        'The channel groups (with member channel ids) and channel tags defined on an instance.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ instanceId: instanceIdField }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const groups = await getJson(instanceId, 'list the channel groups', '/channelgroups');
      if (!groups.ok) return errText(groups.message);
      const tags = await getJson(instanceId, 'list the channel tags', '/server/channelTags');
      if (!tags.ok) return errText(tags.message);
      const groupLines = unwrapList(groups.value).map((group) => {
        if (!isRecord(group)) return '';
        const members = unwrapList(isRecord(group.channels) ? group.channels : []).map((member) =>
          isRecord(member) ? str(member.id) : str(member)
        );
        return `group ${str(group.name)} — id ${str(group.id)} — ${members.length} channel(s): ${members.join(', ')}`;
      });
      const tagLines = unwrapList(tags.value).map((tag) =>
        isRecord(tag)
          ? `tag ${str(tag.name)} — id ${str(tag.id)} — channels: ${unwrapList(
              isRecord(tag.channelIds) ? tag.channelIds : []
            )
              .map(String)
              .join(', ')}`
          : ''
      );
      const lines = [...groupLines, ...tagLines].filter(Boolean);
      return textResult(lines.join('\n') || 'No channel groups or tags are defined.');
    }
  );

  gated('messages.read').registerTool(
    'mirth_search_messages',
    {
      title: 'Mirth · Read — Search the messages of a channel',
      description:
        "Search a channel's message store by id range, dates, status, connector or text. " +
        'Returns one line per message (id, received date, per-connector status); set ' +
        'includeContent for the raw content of each. Use mirth_get_message for one message ' +
        'in full. Message content may contain PHI — request only what the task needs.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        instanceId: instanceIdField,
        channelId: channelIdField,
        ...messageFilterFields,
        includeContent: z.boolean().optional(),
        limit: z.number().int().positive().max(200).optional().describe('Default 20.'),
        offset: z.number().int().nonnegative().optional(),
        maxChars: z.number().int().positive().optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const channelId = str(args.channelId);
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : DEFAULT_MAX_CHARS;
      const found = await getJson(
        instanceId,
        'search the messages',
        `/channels/${encodeURIComponent(channelId)}/messages`,
        {
          ...messageQuery(args),
          includeContent: args.includeContent === true,
          limit: typeof args.limit === 'number' ? args.limit : 20,
          ...(typeof args.offset === 'number' ? { offset: args.offset } : {}),
        }
      );
      if (!found.ok) return errText(found.message);
      const messages = unwrapList(found.value);
      if (messages.length === 0) return textResult('No messages match.');
      const lines = messages.map((message) => {
        if (!isRecord(message)) return '';
        const connectors = unwrapMap(message.connectorMessages);
        const states = Object.values(connectors)
          .map((connector) =>
            isRecord(connector) ? `${str(connector.connectorName)}:${str(connector.status)}` : ''
          )
          .filter(Boolean)
          .join(' ');
        let content = '';
        if (args.includeContent === true) {
          const source = Object.values(connectors).find(
            (connector) => isRecord(connector) && Number(connector.metaDataId) === 0
          );
          const raw = isRecord(source) && isRecord(source.raw) ? str(source.raw.content) : '';
          if (raw) content = `\n    ${clip(raw.replace(/\r?\n/g, ' | '), 1_000)}`;
        }
        return `#${textOf(message.messageId)} — received ${dateOf(message.receivedDate)} — ${states || 'no connector messages'}${content}`;
      });
      return textResult(
        clip(`${messages.length} message(s):\n${lines.filter(Boolean).join('\n')}`, maxChars)
      );
    }
  );

  gated('messages.read').registerTool(
    'mirth_count_messages',
    {
      title: 'Mirth · Read — Count the messages matching a filter',
      description: "How many messages in a channel's store match the given filter (all, if none).",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        instanceId: instanceIdField,
        channelId: channelIdField,
        ...messageFilterFields,
      }),
    },
    async (args: Record<string, unknown>) => {
      const counted = await call(str(args.instanceId), 'count the messages', {
        method: 'GET',
        path: `/channels/${encodeURIComponent(str(args.channelId))}/messages/count`,
        query: messageQuery(args),
        accept: 'text/plain',
      });
      if (!counted.ok) return errText(counted.message);
      const raw = counted.response.body.trim();
      const parsed = parseJson(raw);
      const count = isRecord(parsed) && 'long' in parsed ? textOf(parsed.long) : raw;
      return textResult(`${count} message(s) match.`);
    }
  );

  gated('messages.read').registerTool(
    'mirth_get_message',
    {
      title: 'Mirth · Read — One message with its connector content',
      description:
        'One message by id: for the source and each destination, the status, raw / ' +
        'transformed / encoded / sent / response content and any error, truncated per part. ' +
        'Message content may contain PHI — request only what the task needs.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        instanceId: instanceIdField,
        channelId: channelIdField,
        messageId: z.number().int().describe('From mirth_search_messages.'),
        metaDataId: connectorField
          .optional()
          .describe('Only this connector (0 = source), by metaDataId or name.'),
        maxCharsPerPart: z.number().int().positive().optional().describe('Default 4000.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const perPart = typeof args.maxCharsPerPart === 'number' ? args.maxCharsPerPart : 4_000;
      const found = await getJson(
        str(args.instanceId),
        'read the message',
        `/channels/${encodeURIComponent(str(args.channelId))}/messages/${encodeURIComponent(String(args.messageId))}`,
        typeof args.metaDataId === 'number' ? { metaDataId: args.metaDataId } : undefined
      );
      if (!found.ok) return errText(found.message);
      const message =
        isRecord(found.value) && isRecord(found.value.message) ? found.value.message : found.value;
      if (!isRecord(message) || message.messageId === undefined) {
        return errText('Mirth has no message with that id on this channel.');
      }
      const lines = [
        `Message #${textOf(message.messageId)} — received ${dateOf(message.receivedDate)} — processed: ${textOf(message.processed)}`,
      ];
      for (const connector of Object.values(unwrapMap(message.connectorMessages))) {
        if (!isRecord(connector)) continue;
        lines.push(
          `\n== connector ${textOf(connector.metaDataId)} ${str(connector.connectorName)} — ${str(connector.status)} — send attempts ${textOf(connector.sendAttempts)}`
        );
        for (const part of [
          'raw',
          'processedRaw',
          'transformed',
          'encoded',
          'sent',
          'response',
          'processedResponse',
        ]) {
          const content = connector[part];
          if (isRecord(content) && str(content.content)) {
            lines.push(
              `-- ${part} (${str(content.dataType)}):\n${clip(str(content.content), perPart)}`
            );
          }
        }
        for (const errorPart of ['processingError', 'postProcessorError', 'responseError']) {
          const detail = connector[errorPart];
          const text = isRecord(detail) ? str(detail.content) : str(detail);
          if (text) lines.push(`-- ${errorPart}:\n${clip(text, perPart)}`);
        }
      }
      return textResult(lines.join('\n'));
    }
  );

  gated('events.read').registerTool(
    'mirth_list_events',
    {
      title: 'Mirth · Read — Server events (audit log)',
      description:
        "Mirth's server event log — logins, deployments, channel changes, errors — filtered " +
        'by level, name, outcome, user, date or id range.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        instanceId: instanceIdField,
        levels: z.array(z.enum(['INFORMATION', 'WARNING', 'ERROR'])).optional(),
        name: z.string().optional().describe('Event name fragment (e.g. "Deploy").'),
        outcome: z.enum(['SUCCESS', 'FAILURE']).optional(),
        userId: z.number().int().optional(),
        startDate: dateField('On or after.'),
        endDate: dateField('On or before.'),
        minEventId: z.number().int().optional(),
        maxEventId: z.number().int().optional(),
        limit: z.number().int().positive().max(500).optional().describe('Default 50.'),
        offset: z.number().int().nonnegative().optional(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const found = await getJson(str(args.instanceId), 'read the events', '/events', {
        ...queryOf({
          // Mirth reads the repeatable level filter from the singular key.
          level: Array.isArray(args.levels) ? args.levels.map(String) : undefined,
          name: str(args.name) || undefined,
          outcome: str(args.outcome) || undefined,
          userId: typeof args.userId === 'number' ? args.userId : undefined,
          startDate: dateArg(args.startDate),
          endDate: dateArg(args.endDate),
          minEventId: typeof args.minEventId === 'number' ? args.minEventId : undefined,
          maxEventId: typeof args.maxEventId === 'number' ? args.maxEventId : undefined,
          offset: typeof args.offset === 'number' ? args.offset : undefined,
        }),
        limit: typeof args.limit === 'number' ? args.limit : 50,
      });
      if (!found.ok) return errText(found.message);
      // User ids are integers the legend cannot recognise; name them here.
      const users = await directory.entries(str(args.instanceId), 'user');
      const usernames = new Map(typeof users === 'string' ? [] : users.map((u) => [u.id, u.name]));
      const lines = unwrapList(found.value).map((event) => {
        if (!isRecord(event)) return '';
        const attributes = unwrapMap(event.attributes);
        const userLabel = `${textOf(event.userId)}${usernames.has(textOf(event.userId)) ? ` (${usernames.get(textOf(event.userId))})` : ''}`;
        const detail = Object.entries(attributes)
          .map(([key, value]) => `${key}=${clip(textOf(value), 120)}`)
          .join(', ');
        return `#${textOf(event.id)} ${dateOf(event.eventTime)} ${str(event.level)} ${str(event.name)} — ${str(event.outcome)} — user ${userLabel} from ${str(event.ipAddress)}${detail ? ` — ${detail}` : ''}`;
      });
      return textResult(
        clip(lines.filter(Boolean).join('\n') || 'No events match.', DEFAULT_MAX_CHARS)
      );
    }
  );

  gated('alerts.read').registerTool(
    'mirth_list_alerts',
    {
      title: 'Mirth · Read — Alerts and their status',
      description:
        'Every alert defined on an instance with its enabled state and alerted/sent counts.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ instanceId: instanceIdField }),
    },
    async (args: Record<string, unknown>) => {
      const statuses = await getJson(str(args.instanceId), 'list the alerts', '/alerts/statuses');
      if (!statuses.ok) return errText(statuses.message);
      const lines = unwrapList(statuses.value).map((alert) =>
        isRecord(alert)
          ? `${str(alert.name)} — id ${str(alert.id)} — ${alert.enabled === true || alert.enabled === 'true' ? 'enabled' : 'disabled'} — alerted ${textOf(alert.alertedCount)}`
          : ''
      );
      return textResult(lines.filter(Boolean).join('\n') || 'No alerts are defined.');
    }
  );

  gated('alerts.read').registerTool(
    'mirth_get_alert',
    {
      title: 'Mirth · Read — One alert definition',
      description: 'The full definition of one alert (trigger, channels, actions) as JSON.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        instanceId: instanceIdField,
        alertId: z.string().min(1).describe('The alert id or its name (from mirth_list_alerts).'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const alert = await getJson(
        str(args.instanceId),
        'read the alert',
        `/alerts/${encodeURIComponent(str(args.alertId))}`
      );
      if (!alert.ok) return errText(alert.message);
      if (alert.value === null) return errText('Mirth has no alert with that id.');
      return textResult(clip(JSON.stringify(alert.value, null, 2), DEFAULT_MAX_CHARS));
    }
  );

  gated('code_templates.read').registerTool(
    'mirth_list_code_templates',
    {
      title: 'Mirth · Read — Code template libraries and templates',
      description:
        'The code template libraries on an instance and the templates each holds (ids and names).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ instanceId: instanceIdField }),
    },
    async (args: Record<string, unknown>) => {
      const libraries = await getJson(
        str(args.instanceId),
        'list the code templates',
        '/codeTemplateLibraries',
        {
          includeCodeTemplates: true,
        }
      );
      if (!libraries.ok) return errText(libraries.message);
      const lines: string[] = [];
      for (const library of unwrapList(libraries.value)) {
        if (!isRecord(library)) continue;
        lines.push(
          `library ${str(library.name)} — id ${str(library.id)} — revision ${textOf(library.revision)}`
        );
        for (const template of unwrapList(
          isRecord(library.codeTemplates) ? library.codeTemplates : []
        )) {
          if (isRecord(template)) {
            lines.push(
              `  template ${str(template.name)} — id ${str(template.id)} — ${str(template.type) || (isRecord(template.properties) ? str(template.properties.type) : '')}`
            );
          }
        }
      }
      return textResult(lines.join('\n') || 'No code template libraries are defined.');
    }
  );

  gated('code_templates.read').registerTool(
    'mirth_get_code_template',
    {
      title: 'Mirth · Read — One code template with its code',
      description: 'One code template by id, including its JavaScript.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        instanceId: instanceIdField,
        codeTemplateId: z
          .string()
          .min(1)
          .describe('The code template id or its name (from mirth_list_code_templates).'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const template = await getJson(
        str(args.instanceId),
        'read the code template',
        `/codeTemplates/${encodeURIComponent(str(args.codeTemplateId))}`
      );
      if (!template.ok) return errText(template.message);
      const root =
        isRecord(template.value) && isRecord(template.value.codeTemplate)
          ? template.value.codeTemplate
          : template.value;
      if (!isRecord(root) || !str(root.id))
        return errText('Mirth has no code template with that id.');
      const code = isRecord(root.properties) ? str(root.properties.code) : '';
      return textResult(
        `${str(root.name)} — id ${str(root.id)} — revision ${textOf(root.revision)}\n${str(root.description) ? `${str(root.description)}\n` : ''}\n${clip(code, DEFAULT_MAX_CHARS)}`
      );
    }
  );

  gated('users.read').registerTool(
    'mirth_list_users',
    {
      title: 'Mirth · Read — Users of an instance',
      description:
        'The Mirth user accounts on an instance (id, username, name, email, last login).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ instanceId: instanceIdField }),
    },
    async (args: Record<string, unknown>) => {
      const users = await getJson(str(args.instanceId), 'list the users', '/users');
      if (!users.ok) return errText(users.message);
      const lines = unwrapList(users.value).map((user) =>
        isRecord(user)
          ? `#${textOf(user.id)} ${str(user.username)} — ${[str(user.firstName), str(user.lastName)].filter(Boolean).join(' ') || '(no name)'} — ${str(user.email) || 'no email'} — last login ${dateOf(user.lastLogin) || 'never'}`
          : ''
      );
      return textResult(lines.filter(Boolean).join('\n') || 'No users were returned.');
    }
  );

  gated('server.read').registerTool(
    'mirth_list_extensions',
    {
      title: 'Mirth · Read — Installed connectors and plugins',
      description: 'The connector and plugin extensions installed on an instance, with versions.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ instanceId: instanceIdField }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const connectors = await getJson(instanceId, 'list the connectors', '/extensions/connectors');
      if (!connectors.ok) return errText(connectors.message);
      const plugins = await getJson(instanceId, 'list the plugins', '/extensions/plugins');
      if (!plugins.ok) return errText(plugins.message);
      const line = (kind: string) => (entry: unknown) =>
        isRecord(entry)
          ? `${kind} ${str(entry.name)} — ${str(entry.pluginVersion)} — by ${str(entry.author)}`
          : '';
      const lines = [
        ...Object.values(unwrapMap(connectors.value)).map(line('connector')),
        ...Object.values(unwrapMap(plugins.value)).map(line('plugin')),
      ].filter(Boolean);
      return textResult(lines.join('\n') || 'No extensions were returned.');
    }
  );

  gated('server.read').registerTool(
    'mirth_get_configuration_map',
    {
      title: 'Mirth · Read — The configuration map',
      description:
        'Every entry of the server configuration map (key, value, comment) — the values channels read with configurationMap.get().',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ instanceId: instanceIdField }),
    },
    async (args: Record<string, unknown>) => {
      const map = await getJson(
        str(args.instanceId),
        'read the configuration map',
        '/server/configurationMap'
      );
      if (!map.ok) return errText(map.message);
      const lines = Object.entries(unwrapMap(map.value)).map(([key, property]) =>
        isRecord(property)
          ? `${key} = ${str(property.value)}${str(property.comment) ? `  # ${str(property.comment)}` : ''}`
          : `${key} = ${textOf(property)}`
      );
      return textResult(
        clip(lines.join('\n') || 'The configuration map is empty.', DEFAULT_MAX_CHARS)
      );
    }
  );

  gated('server.read').registerTool(
    'mirth_get_global_scripts',
    {
      title: 'Mirth · Read — Global scripts',
      description: 'The Deploy, Undeploy, Preprocessor and Postprocessor global scripts.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ instanceId: instanceIdField }),
    },
    async (args: Record<string, unknown>) => {
      const scripts = await getJson(
        str(args.instanceId),
        'read the global scripts',
        '/server/globalScripts'
      );
      if (!scripts.ok) return errText(scripts.message);
      const lines = Object.entries(unwrapMap(scripts.value)).map(
        ([name, code]) => `== ${name}\n${textOf(code)}`
      );
      return textResult(
        clip(lines.join('\n\n') || 'No global scripts were returned.', DEFAULT_MAX_CHARS)
      );
    }
  );

  gated('server.read').registerTool(
    'mirth_get_server_settings',
    {
      title: 'Mirth · Read — Server settings',
      description:
        'The server settings (environment name, SMTP, queue buffer, default metadata columns…) as JSON.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ instanceId: instanceIdField }),
    },
    async (args: Record<string, unknown>) => {
      const settings = await getJson(
        str(args.instanceId),
        'read the server settings',
        '/server/settings'
      );
      if (!settings.ok) return errText(settings.message);
      return textResult(clip(JSON.stringify(settings.value, null, 2), DEFAULT_MAX_CHARS));
    }
  );

  // Every route the curated tools do not phrase, one named tool each,
  // for the permissions this caller holds somewhere.
  registerOperationTools(server, runtime, granted);

  // -------------------------------------------------------------------
  // Act tools — each behind the permission it names, registered when the
  // caller holds it somewhere and re-checked per instance on every call.
  // -------------------------------------------------------------------

  /** Run one per-channel POST for a bounded list of ids and report per id. */
  const perChannel = async (
    instanceId: string,
    what: string,
    ids: string[],
    pathFor: (id: string) => string,
    query?: MirthApiRequest['query']
  ): Promise<ToolResult> => {
    if (ids.length === 0) return errText('Give at least one channel id.');
    if (ids.length > MAX_BULK_CHANNELS) {
      return errText(`At most ${MAX_BULK_CHANNELS} channels per call; split the list.`);
    }
    const lines: string[] = [];
    let failures = 0;
    for (const id of ids) {
      const answered = await call(instanceId, `${what} ${id}`, {
        method: 'POST',
        path: pathFor(id),
        query: { returnErrors: true, ...(query ?? {}) },
      });
      if (answered.ok) lines.push(`${id}: ok`);
      else {
        failures += 1;
        lines.push(`${id}: ${answered.message}`);
      }
    }
    const summary = `${ids.length - failures}/${ids.length} succeeded.\n${lines.join('\n')}`;
    return failures === ids.length ? errText(summary) : textResult(summary);
  };

  const channelIdsField = z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_BULK_CHANNELS)
    .describe('Channel ids (from mirth_list_channels).');

  gated('channels.deploy').registerTool(
    'mirth_deploy_channels',
    {
      title: 'Mirth · Act — Deploy (or redeploy) channels',
      description:
        'Deploy the named channels, or every channel (redeploy all). Deploying a running channel ' +
        'redeploys it with its latest saved revision.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        instanceId: instanceIdField,
        channelIds: z.array(z.string().min(1)).max(MAX_BULK_CHANNELS).optional(),
        all: z.boolean().optional().describe('Redeploy every channel instead of a list.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'channels.deploy');
      if (refusal) return errText(refusal);
      if (args.all === true) {
        const answered = await call(instanceId, 'redeploy all channels', {
          method: 'POST',
          path: '/channels/_redeployAll',
          query: { returnErrors: true },
        });
        return answered.ok ? textResult('All channels redeployed.') : errText(answered.message);
      }
      const ids = Array.isArray(args.channelIds) ? args.channelIds.map(String) : [];
      return perChannel(
        instanceId,
        'deploy',
        ids,
        (id) => `/channels/${encodeURIComponent(id)}/_deploy`
      );
    }
  );

  gated('channels.deploy').registerTool(
    'mirth_undeploy_channels',
    {
      title: 'Mirth · Act — Undeploy channels',
      description:
        'Undeploy the named channels. Their definitions stay; they stop processing until deployed again.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({ instanceId: instanceIdField, channelIds: channelIdsField }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'channels.deploy');
      if (refusal) return errText(refusal);
      const ids = Array.isArray(args.channelIds) ? args.channelIds.map(String) : [];
      return perChannel(
        instanceId,
        'undeploy',
        ids,
        (id) => `/channels/${encodeURIComponent(id)}/_undeploy`
      );
    }
  );

  gated('channels.deploy').registerTool(
    'mirth_control_channels',
    {
      title: 'Mirth · Act — Start, stop, pause, resume or halt channels',
      description:
        'Change the running state of deployed channels. stop finishes in-flight messages; halt ' +
        'aborts them. Undeployed channels are refused by Mirth — deploy first.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        instanceId: instanceIdField,
        action: z.enum(['start', 'stop', 'pause', 'resume', 'halt']),
        channelIds: channelIdsField,
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'channels.deploy');
      if (refusal) return errText(refusal);
      const action = str(args.action);
      if (!['start', 'stop', 'pause', 'resume', 'halt'].includes(action))
        return errText('Unknown action.');
      const ids = Array.isArray(args.channelIds) ? args.channelIds.map(String) : [];
      return perChannel(
        instanceId,
        action,
        ids,
        (id) => `/channels/${encodeURIComponent(id)}/_${action}`
      );
    }
  );

  gated('channels.deploy').registerTool(
    'mirth_control_connector',
    {
      title: 'Mirth · Act — Start or stop one connector of a channel',
      description:
        'Start or stop a single connector (source metaDataId 0, destinations 1..) of a deployed channel.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        instanceId: instanceIdField,
        channelId: channelIdField,
        metaDataId: connectorField,
        action: z.enum(['start', 'stop']),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'channels.deploy');
      if (refusal) return errText(refusal);
      const action = str(args.action) === 'stop' ? 'stop' : 'start';
      const answered = await call(instanceId, `${action} the connector`, {
        method: 'POST',
        path: `/channels/${encodeURIComponent(str(args.channelId))}/connector/${encodeURIComponent(String(args.metaDataId))}/_${action}`,
        query: { returnErrors: true },
      });
      return answered.ok
        ? textResult(`Connector ${textOf(args.metaDataId)} ${action}ed.`)
        : errText(answered.message);
    }
  );

  gated('channels.edit').registerTool(
    'mirth_set_channel_enabled',
    {
      title: 'Mirth · Act — Enable or disable a channel',
      description:
        'Set the enabled flag of a channel definition (a disabled channel cannot be deployed).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        instanceId: instanceIdField,
        channelId: channelIdField,
        enabled: z.boolean(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'channels.edit');
      if (refusal) return errText(refusal);
      const enabled = args.enabled === true;
      const answered = await call(instanceId, `${enabled ? 'enable' : 'disable'} the channel`, {
        method: 'POST',
        path: `/channels/${encodeURIComponent(str(args.channelId))}/enabled/${enabled}`,
      });
      return answered.ok
        ? textResult(`Channel ${str(args.channelId)} ${enabled ? 'enabled' : 'disabled'}.`)
        : errText(answered.message);
    }
  );

  gated('channels.edit').registerTool(
    'mirth_set_channel_initial_state',
    {
      title: 'Mirth · Act — Set the state a channel takes when deployed',
      description: 'Whether a channel starts, stays stopped, or pauses when it is deployed.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        instanceId: instanceIdField,
        channelId: channelIdField,
        initialState: z.enum(['STARTED', 'STOPPED', 'PAUSED']),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'channels.edit');
      if (refusal) return errText(refusal);
      const answered = await call(instanceId, 'set the initial state', {
        method: 'POST',
        path: `/channels/${encodeURIComponent(str(args.channelId))}/initialState/${encodeURIComponent(str(args.initialState))}`,
      });
      return answered.ok
        ? textResult(`Initial state of ${str(args.channelId)} set to ${str(args.initialState)}.`)
        : errText(answered.message);
    }
  );

  gated('channels.edit').registerTool(
    'mirth_import_channel',
    {
      title: 'Mirth · Act — Create or update a channel from its XML',
      description:
        'Save a channel definition given as the XML the Mirth Administrator exports (from ' +
        'mirth_get_channel with format "xml", edited as needed). The <id> inside the XML decides: ' +
        'an existing id is updated (override), a new id is created. Saving does not deploy — call ' +
        'mirth_deploy_channels afterwards.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        instanceId: instanceIdField,
        channelXml: z.string().min(1).describe('The full <channel>…</channel> document.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'channels.edit');
      if (refusal) return errText(refusal);
      const xml = str(args.channelXml).trim();
      const idMatch = xml.match(/<channel[^>]*>[\s\S]*?<id>([^<]+)<\/id>/);
      const channelId = idMatch ? idMatch[1].trim() : '';
      if (!xml.startsWith('<') || !channelId) {
        return errText('The XML must be a <channel> document with an <id> element.');
      }
      const names = await getJson(instanceId, 'check the channel id', '/channels/idsAndNames');
      if (!names.ok) return errText(names.message);
      const exists = channelId in unwrapMap(names.value);
      const answered = await call(
        instanceId,
        exists ? 'update the channel' : 'create the channel',
        {
          method: exists ? 'PUT' : 'POST',
          path: exists ? `/channels/${encodeURIComponent(channelId)}` : '/channels',
          query: exists ? { override: true } : undefined,
          body: xml,
          contentType: 'application/xml',
          accept: 'text/plain',
        }
      );
      if (!answered.ok) return errText(answered.message);
      const verdict = answered.response.body.trim();
      if (verdict === 'false') {
        return errText(
          'Mirth declined the save (a newer revision exists, or the definition was rejected).'
        );
      }
      return textResult(
        `Channel ${channelId} ${exists ? 'updated' : 'created'}. Deploy it with mirth_deploy_channels to run the new revision.`
      );
    }
  );

  gated('messages.send').registerTool(
    'mirth_send_message',
    {
      title: 'Mirth · Act — Send a message through a channel',
      description:
        "Process a new message through a deployed channel's source connector (the Administrator's " +
        '"Send Message"). Optionally restrict which destinations receive it, and seed sourceMap ' +
        'entries. Content is sent as-is (HL7, XML, JSON, raw…).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        instanceId: instanceIdField,
        channelId: channelIdField,
        content: z.string().min(1).describe('The raw message.'),
        destinationMetaDataIds: z
          .array(connectorField)
          .optional()
          .describe('Only these destinations; default all.'),
        sourceMap: z
          .record(z.string(), z.string())
          .optional()
          .describe('sourceMap entries, key → value.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'messages.send');
      if (refusal) return errText(refusal);
      const sourceMap = isRecord(args.sourceMap)
        ? Object.entries(args.sourceMap).map(([key, value]) => `${key}=${textOf(value)}`)
        : [];
      const answered = await call(instanceId, 'send the message', {
        method: 'POST',
        path: `/channels/${encodeURIComponent(str(args.channelId))}/messages`,
        query: queryOf({
          destinationMetaDataId: Array.isArray(args.destinationMetaDataIds)
            ? args.destinationMetaDataIds.map(String)
            : undefined,
          sourceMapEntry: sourceMap.length ? sourceMap : undefined,
        }),
        body: str(args.content),
        contentType: 'text/plain',
        accept: 'text/plain',
      });
      if (!answered.ok) return errText(answered.message);
      const detail = answered.response.body.trim();
      return textResult(
        `Message accepted by the channel${detail ? ` (${clip(detail, 500)})` : ''}. mirth_search_messages shows how it was processed.`
      );
    }
  );

  gated('messages.send').registerTool(
    'mirth_reprocess_messages',
    {
      title: 'Mirth · Act — Reprocess one message or a filtered set',
      description:
        'Reprocess a single message by id, or every message matching a filter (at least one ' +
        'filter is required — a blanket reprocess of the whole store is refused). replace ' +
        'overwrites the original; otherwise a new message is created per reprocess.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        instanceId: instanceIdField,
        channelId: channelIdField,
        messageId: z.number().int().optional().describe('One message; omit to use the filter.'),
        ...messageFilterFields,
        replace: z
          .boolean()
          .optional()
          .describe('Overwrite the original messages (default false).'),
        destinationMetaDataIds: z
          .array(connectorField)
          .optional()
          .describe('Reprocess only through these destinations.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'messages.send');
      if (refusal) return errText(refusal);
      const channel = encodeURIComponent(str(args.channelId));
      const common = queryOf({
        replace: args.replace === true,
        filterDestinations:
          Array.isArray(args.destinationMetaDataIds) && args.destinationMetaDataIds.length > 0,
        metaDataId: Array.isArray(args.destinationMetaDataIds)
          ? args.destinationMetaDataIds.map(String)
          : undefined,
      });
      if (typeof args.messageId === 'number') {
        const answered = await call(instanceId, 'reprocess the message', {
          method: 'POST',
          path: `/channels/${channel}/messages/${encodeURIComponent(String(args.messageId))}/_reprocess`,
          query: common,
        });
        return answered.ok
          ? textResult(`Message #${textOf(args.messageId)} queued for reprocessing.`)
          : errText(answered.message);
      }
      const filter = messageQuery(args);
      if (Object.keys(filter).length === 0) {
        return errText(
          'Give a messageId or at least one filter — reprocessing every message in the store is refused here.'
        );
      }
      const answered = await call(instanceId, 'reprocess the messages', {
        method: 'POST',
        path: `/channels/${channel}/messages/_reprocess`,
        query: { ...filter, ...common },
      });
      return answered.ok
        ? textResult('Matching messages queued for reprocessing.')
        : errText(answered.message);
    }
  );

  gated('server.configure').registerTool(
    'mirth_set_configuration_map',
    {
      title: 'Mirth · Act — Set configuration map entries',
      description:
        'Add or change entries of the server configuration map, keeping every other entry ' +
        '(a value of null removes the key). Channels read the new values on their next ' +
        'configurationMap.get(); a redeploy is not required.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        instanceId: instanceIdField,
        entries: z
          .record(
            z.string().min(1),
            z.union([
              z.object({ value: z.string(), comment: z.string().optional() }),
              z.string(),
              z.null(),
            ])
          )
          .describe('key → value (string), {value, comment}, or null to remove.'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'server.configure');
      if (refusal) return errText(refusal);
      const current = await getJson(
        instanceId,
        'read the configuration map',
        '/server/configurationMap'
      );
      if (!current.ok) return errText(current.message);
      const entries = new Map<string, { value: string; comment: string }>();
      for (const [key, property] of Object.entries(unwrapMap(current.value))) {
        entries.set(key, {
          value: isRecord(property) ? str(property.value) : textOf(property),
          comment: isRecord(property) ? str(property.comment) : '',
        });
      }
      const changes = isRecord(args.entries) ? args.entries : {};
      const changed: string[] = [];
      for (const [key, change] of Object.entries(changes)) {
        if (change === null) {
          if (entries.delete(key)) changed.push(`removed ${key}`);
          continue;
        }
        const next =
          typeof change === 'string'
            ? { value: change, comment: entries.get(key)?.comment ?? '' }
            : {
                value: str(isRecord(change) ? change.value : ''),
                comment:
                  str(isRecord(change) ? change.comment : '') || (entries.get(key)?.comment ?? ''),
              };
        entries.set(key, next);
        changed.push(`${key} = ${next.value}`);
      }
      // The XML form is the canonical wire shape; it round-trips exactly.
      const escape = (text: string) =>
        text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const xml =
        '<map>' +
        [...entries.entries()]
          .map(
            ([key, property]) =>
              `<entry><string>${escape(key)}</string><com.mirth.connect.util.ConfigurationProperty><value>${escape(property.value)}</value>${property.comment ? `<comment>${escape(property.comment)}</comment>` : ''}</com.mirth.connect.util.ConfigurationProperty></entry>`
          )
          .join('') +
        '</map>';
      const answered = await call(instanceId, 'update the configuration map', {
        method: 'PUT',
        path: '/server/configurationMap',
        body: xml,
        contentType: 'application/xml',
      });
      if (!answered.ok) return errText(answered.message);
      return textResult(
        changed.length
          ? `Configuration map updated:\n${changed.join('\n')}`
          : 'No changes were requested; the map is unchanged.'
      );
    }
  );

  gated('server.configure').registerTool(
    'mirth_set_global_scripts',
    {
      title: 'Mirth · Act — Update global scripts',
      description:
        'Replace one or more of the Deploy, Undeploy, Preprocessor and Postprocessor global scripts, keeping the others.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        instanceId: instanceIdField,
        scripts: z.object({
          Deploy: z.string().optional(),
          Undeploy: z.string().optional(),
          Preprocessor: z.string().optional(),
          Postprocessor: z.string().optional(),
        }),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'server.configure');
      if (refusal) return errText(refusal);
      const current = await getJson(instanceId, 'read the global scripts', '/server/globalScripts');
      if (!current.ok) return errText(current.message);
      const scripts = new Map<string, string>(
        Object.entries(unwrapMap(current.value)).map(([name, code]) => [name, textOf(code)])
      );
      const changes = isRecord(args.scripts) ? args.scripts : {};
      const changed: string[] = [];
      for (const name of ['Deploy', 'Undeploy', 'Preprocessor', 'Postprocessor']) {
        if (typeof changes[name] === 'string') {
          scripts.set(name, changes[name]);
          changed.push(name);
        }
      }
      if (changed.length === 0) return errText('Give at least one script to change.');
      const escape = (text: string) =>
        text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const xml =
        '<map>' +
        [...scripts.entries()]
          .map(
            ([name, code]) =>
              `<entry><string>${escape(name)}</string><string>${escape(code)}</string></entry>`
          )
          .join('') +
        '</map>';
      const answered = await call(instanceId, 'update the global scripts', {
        method: 'PUT',
        path: '/server/globalScripts',
        body: xml,
        contentType: 'application/xml',
      });
      return answered.ok
        ? textResult(
            `Global scripts updated: ${changed.join(', ')}. Redeploy channels for Deploy/Undeploy changes to take effect.`
          )
        : errText(answered.message);
    }
  );

  gated('alerts.edit').registerTool(
    'mirth_set_alert_enabled',
    {
      title: 'Mirth · Act — Enable or disable an alert',
      description: 'Turn one alert on or off.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        instanceId: instanceIdField,
        alertId: z.string().min(1),
        enabled: z.boolean(),
      }),
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'alerts.edit');
      if (refusal) return errText(refusal);
      const enabled = args.enabled === true;
      const answered = await call(instanceId, `${enabled ? 'enable' : 'disable'} the alert`, {
        method: 'POST',
        path: `/alerts/${encodeURIComponent(str(args.alertId))}/_${enabled ? 'enable' : 'disable'}`,
      });
      return answered.ok
        ? textResult(`Alert ${str(args.alertId)} ${enabled ? 'enabled' : 'disabled'}.`)
        : errText(answered.message);
    }
  );

  /*
    Destructive operations are preview + confirm only (the fileshare delete
    shape): deleting a channel or purging a message store has no undo, so
    the card puts a human click between the model and the irreversible act.
    Both registrations run through the same handler — the confirm path IS
    the destructive path — and both re-check the per-instance opt-in,
    because the card can outlive a change of heart on the connectors page.
  */

  const previewGuidance = (what: string) =>
    `${what} is awaiting the user's decision on the preview card. Do not do it another ` +
    `way and do not repeat its contents in your reply; the user confirms or cancels from ` +
    `the card. If no card appeared in this client, ask the user how to proceed.`;

  const deleteChannelSchema = z.object({ instanceId: instanceIdField, channelId: channelIdField });

  const deleteChannelHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const instanceId = str(args.instanceId);
    const refusal = await exposureRefusal(instanceId, 'channels.delete');
    if (refusal) return errText(refusal);
    const answered = await call(instanceId, 'delete the channel', {
      method: 'DELETE',
      path: `/channels/${encodeURIComponent(str(args.channelId))}`,
    });
    return answered.ok
      ? textResult(`Channel ${str(args.channelId)} deleted.`)
      : errText(answered.message);
  };

  gated('channels.delete').registerTool(
    'mirth_delete_channel_preview',
    {
      title: 'Mirth · Act — Preview deleting a channel before it happens',
      description:
        'Show the user an interactive card to confirm or cancel deleting a channel definition ' +
        '(and its message store). This is the only way to delete a channel here — there is no ' +
        'undo, so the user decides on the card. Requires destructive operations enabled for the ' +
        'instance on the Connectors page.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: deleteChannelSchema,
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'channels.delete');
      if (refusal) return errText(refusal);
      const names = await getJson(instanceId, 'find the channel', '/channels/idsAndNames');
      if (!names.ok) return errText(names.message);
      const name = unwrapMap(names.value)[str(args.channelId)];
      if (name === undefined) return errText('Mirth has no channel with that id.');
      const connected = await auth.listConnected();
      const instanceName =
        typeof connected === 'string'
          ? instanceId
          : (connected.find((entry) => entry.instance.id === instanceId)?.instance.name ??
            instanceId);
      return {
        content: [
          {
            type: 'text' as const,
            text: previewGuidance(`The deletion of channel ${textOf(name)}`),
          },
        ],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: `Delete channel ${textOf(name)} permanently`,
          subtitle: `${instanceName} · ${str(args.channelId)}`,
          confirmTool: 'mirth_delete_channel_confirm',
          confirmLabel: 'Delete permanently',
          confirmArgs: args,
          fields: [
            { label: 'Instance', value: instanceName },
            { label: 'Channel', value: textOf(name) },
            { label: 'Id', value: str(args.channelId) },
            { label: 'Undo', value: 'None — the definition and its message store are removed' },
          ],
        },
      };
    }
  );

  gated('channels.delete').registerTool(
    'mirth_delete_channel_confirm',
    {
      title: 'Mirth · Act — Execute a confirmed channel deletion',
      description:
        'Delete the channel the user confirmed on the preview card. ' +
        confirmGuard('mirth_delete_channel_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: deleteChannelSchema,
    },
    deleteChannelHandler
  );

  const removeMessagesSchema = z.object({
    instanceId: instanceIdField,
    channelId: channelIdField,
    ...messageFilterFields,
    all: z
      .boolean()
      .optional()
      .describe('Remove EVERY message of the channel (ignores the filter).'),
    clearStatistics: z
      .boolean()
      .optional()
      .describe('With all: also reset the channel statistics.'),
  });

  const removeMessagesHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const instanceId = str(args.instanceId);
    const refusal = await exposureRefusal(instanceId, 'messages.delete');
    if (refusal) return errText(refusal);
    const channel = encodeURIComponent(str(args.channelId));
    const filter = messageQuery(args);
    if (args.all !== true && Object.keys(filter).length === 0) {
      return errText('Give a filter, or set all: true to purge the whole store.');
    }
    const answered = await call(instanceId, 'remove the messages', {
      method: 'DELETE',
      path:
        args.all === true
          ? `/channels/${channel}/messages/_removeAll`
          : `/channels/${channel}/messages`,
      query:
        args.all === true
          ? { restartRunningChannels: true, clearStatistics: args.clearStatistics === true }
          : filter,
    });
    return answered.ok
      ? textResult(
          args.all === true
            ? 'All messages removed from the channel.'
            : 'Matching messages removed.'
        )
      : errText(answered.message);
  };

  gated('messages.delete').registerTool(
    'mirth_remove_messages_preview',
    {
      title: 'Mirth · Act — Preview removing messages before it happens',
      description:
        "Show the user an interactive card to confirm or cancel removing messages from a channel's " +
        'store — a filtered set, or all of them. This is the only way to remove messages here; ' +
        'removal is permanent, so the user decides on the card. Requires destructive operations ' +
        'enabled for the instance on the Connectors page.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: removeMessagesSchema,
    },
    async (args: Record<string, unknown>) => {
      const instanceId = str(args.instanceId);
      const refusal = await exposureRefusal(instanceId, 'messages.delete');
      if (refusal) return errText(refusal);
      const filter = messageQuery(args);
      if (args.all !== true && Object.keys(filter).length === 0) {
        return errText('Give a filter, or set all: true to purge the whole store.');
      }
      const counted = await call(instanceId, 'count the messages', {
        method: 'GET',
        path: `/channels/${encodeURIComponent(str(args.channelId))}/messages/count`,
        query: args.all === true ? undefined : filter,
        accept: 'text/plain',
      });
      if (!counted.ok) return errText(counted.message);
      const raw = counted.response.body.trim();
      const parsed = parseJson(raw);
      const count = isRecord(parsed) && 'long' in parsed ? textOf(parsed.long) : raw;
      const scope = args.all === true ? 'every message' : `${count} matching message(s)`;
      return {
        content: [
          {
            type: 'text' as const,
            text: previewGuidance(`The removal of ${scope} from channel ${str(args.channelId)}`),
          },
        ],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: `Remove ${scope} permanently`,
          subtitle: `channel ${str(args.channelId)}`,
          confirmTool: 'mirth_remove_messages_confirm',
          confirmLabel: 'Remove permanently',
          confirmArgs: args,
          fields: [
            { label: 'Channel', value: str(args.channelId) },
            { label: 'Messages', value: `${count}` },
            {
              label: 'Scope',
              value: args.all === true ? 'Entire message store' : JSON.stringify(filter),
            },
            ...(args.all === true
              ? [{ label: 'Statistics', value: args.clearStatistics === true ? 'Reset' : 'Kept' }]
              : []),
            { label: 'Undo', value: 'None — removal from the message store is permanent' },
          ],
        },
      };
    }
  );

  gated('messages.delete').registerTool(
    'mirth_remove_messages_confirm',
    {
      title: 'Mirth · Act — Execute a confirmed message removal',
      description:
        'Remove the messages the user confirmed on the preview card. ' +
        confirmGuard('mirth_remove_messages_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: removeMessagesSchema,
    },
    removeMessagesHandler
  );
}
