/**
 * Names ↔ ids for the mirth_* tools, in both directions.
 *
 * Mirth addresses everything by id — channels, alerts, code templates and
 * their libraries, groups, tags, resources and database tasks by UUID,
 * users and connectors by integer — while a person says "the ADT inbound
 * channel", "the Lab Results destination", "prod". So:
 *
 *  - **Inbound**, every id-shaped argument of every tool (curated and
 *    generated alike) accepts the id OR the name. `withReferenceResolution`
 *    wraps the server: before a handler runs, `instanceId` is matched
 *    against the caller's connected instances (id, name, or environment
 *    label when unique) and each argument named in `REF_ARGS` is matched
 *    against the instance's directory of that kind. A name that matches
 *    nothing, or more than one thing, is a refusal that lists what exists —
 *    never a guess.
 *  - **Outbound**, a successful answer that mentions ids gets a legend:
 *    every UUID in the text that the directory knows is listed with its
 *    kind and name, so a raw Mirth document still reads. Ids whose name
 *    already appears in the text are left out of the legend — the curated
 *    tools print names beside ids themselves.
 *  - **Explicitly**, `mirth_resolve_ids` and `mirth_resolve_names` (in
 *    index.ts) answer either direction for a list at a time.
 *
 * The directory is a short-lived cache (60 s per instance and kind, per
 * caller) over the same listing routes the tools use, so a burst of calls
 * costs one listing, not one per call; a miss re-reads once before it is
 * reported, so a channel created a moment ago resolves by name.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { isRecord, textOf, unwrapList, unwrapMap } from '@renkei/connector-mirth';
import type { ConnectedInstance } from '@renkei/connector-mirth';
import type { MirthApiRequest, WireApiResponse } from '@/lib/mirth/service-client';

export type RefKind =
  | 'channel'
  | 'channel_group'
  | 'channel_tag'
  | 'alert'
  | 'code_template'
  | 'code_template_library'
  | 'user'
  | 'resource'
  | 'database_task'
  | 'connector';

export const REF_KINDS = [
  'channel',
  'channel_group',
  'channel_tag',
  'alert',
  'code_template',
  'code_template_library',
  'user',
  'resource',
  'database_task',
  'connector',
] as const satisfies readonly RefKind[];

export function isRefKind(value: unknown): value is RefKind {
  return typeof value === 'string' && REF_KINDS.some((kind) => kind === value);
}

/** Kinds whose ids are integers (a bare number is always an id). */
const INTEGER_KINDS = new Set<RefKind>(['user', 'connector']);

/**
 * Which tool arguments are references, by name. One convention for the
 * curated and the generated tools: an argument called `channelId` is a
 * channel wherever it appears, `channelIds` a list of them, and so on.
 * `metaDataId`, `destinationMetaDataIds`, `includedMetaDataId` and
 * `excludedMetaDataId` are connectors OF the channel the same call names.
 *
 * Every id-shaped argument of every tool is either listed here or is a
 * plain identifier with no name (a message, event or attachment id, a
 * numeric bound); the tests hold both the table and the curated schemas
 * to that, so a new reference argument cannot ship unresolvable.
 */
export const REF_ARGS: Record<string, RefKind> = {
  channelId: 'channel',
  channelIds: 'channel',
  alertId: 'alert',
  codeTemplateId: 'code_template',
  libraryId: 'code_template_library',
  userId: 'user',
  userIdOrName: 'user',
  resourceId: 'resource',
  databaseTaskId: 'database_task',
  metaDataId: 'connector',
  destinationMetaDataIds: 'connector',
  includedMetaDataId: 'connector',
  excludedMetaDataId: 'connector',
};

/**
 * Id-shaped arguments that are NOT references: identifiers Mirth never
 * names, so there is nothing to resolve them from. Everything else ending
 * in Id/Ids must be in REF_ARGS.
 */
export const PLAIN_ID_ARGS: ReadonlySet<string> = new Set([
  'instanceId', // resolved separately, against the caller's connected instances
  'messageId',
  'eventId',
  'attachmentId',
  'serverId',
  'patientId',
  'previewId',
  'minMessageId',
  'maxMessageId',
  'minOriginalId',
  'maxOriginalId',
  'minImportId',
  'maxImportId',
  'minEventId',
  'maxEventId',
  'removedChannelGroupIds', // XML documents inside a multipart body, not arguments
  'removedLibraryIds',
  'removedCodeTemplateIds',
]);

export interface RefEntry {
  id: string;
  name: string;
}

export interface RefScope {
  /** For 'connector': the channel whose connectors are meant (already resolved to an id). */
  channelId?: string;
}

export interface Directory {
  /** The entries of one kind on one instance; a string is a user-visible refusal. */
  entries(
    instanceId: string,
    kind: RefKind,
    scope?: RefScope,
    fresh?: boolean
  ): Promise<RefEntry[] | string>;
}

type Caller = (
  instanceId: string,
  what: string,
  request: MirthApiRequest
) => Promise<{ ok: true; response: WireApiResponse } | { ok: false; message: string }>;

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 5_000;
const cache = new Map<string, { expiresAt: number; entries: RefEntry[] }>();

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** id/name pairs out of a Mirth list envelope, whatever the element tag. */
function namedList(value: unknown, idField = 'id', nameField = 'name'): RefEntry[] {
  return unwrapList(value).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = textOf(entry[idField]);
    const name = textOf(entry[nameField]);
    return id && name ? [{ id, name }] : [];
  });
}

/** The route and parsing for each kind. */
async function fetchEntries(
  call: Caller,
  instanceId: string,
  kind: RefKind,
  scope: RefScope
): Promise<RefEntry[] | string> {
  const get = async (path: string, query?: MirthApiRequest['query']) => {
    const answered = await call(instanceId, `list the ${kind.replace('_', ' ')}s`, {
      method: 'GET',
      path,
      query,
    });
    return answered.ok ? parseJson(answered.response.body) : answered.message;
  };
  switch (kind) {
    case 'channel': {
      const value = await get('/channels/idsAndNames');
      if (typeof value === 'string') return value;
      return Object.entries(unwrapMap(value)).map(([id, name]) => ({ id, name: textOf(name) }));
    }
    case 'channel_group': {
      const value = await get('/channelgroups');
      return typeof value === 'string' ? value : namedList(value);
    }
    case 'channel_tag': {
      const value = await get('/server/channelTags');
      return typeof value === 'string' ? value : namedList(value);
    }
    case 'alert': {
      const value = await get('/alerts/statuses');
      return typeof value === 'string' ? value : namedList(value);
    }
    case 'code_template_library':
    case 'code_template': {
      const value = await get('/codeTemplateLibraries', { includeCodeTemplates: true });
      if (typeof value === 'string') return value;
      if (kind === 'code_template_library') return namedList(value);
      return unwrapList(value).flatMap((library) =>
        isRecord(library) && isRecord(library.codeTemplates) ? namedList(library.codeTemplates) : []
      );
    }
    case 'user': {
      const value = await get('/users');
      return typeof value === 'string' ? value : namedList(value, 'id', 'username');
    }
    case 'resource': {
      const value = await get('/server/resources');
      return typeof value === 'string' ? value : namedList(value);
    }
    case 'database_task': {
      const value = await get('/databaseTasks');
      return typeof value === 'string' ? value : namedList(value);
    }
    case 'connector': {
      if (!scope.channelId) return 'A connector name can only be resolved for a given channel.';
      const value = await get(`/channels/${encodeURIComponent(scope.channelId)}/connectorNames`);
      if (typeof value === 'string') return value;
      return Object.entries(unwrapMap(value)).map(([id, name]) => ({ id, name: textOf(name) }));
    }
  }
}

/** The production directory: cached listings over the caller's own session. */
export function createDirectory(
  call: Caller,
  scopeKey: string,
  now: () => number = Date.now
): Directory {
  return {
    async entries(instanceId, kind, scope = {}, fresh = false) {
      const key = `${scopeKey}|${instanceId}|${kind}|${scope.channelId ?? ''}`;
      const cached = cache.get(key);
      if (!fresh && cached && cached.expiresAt > now()) return cached.entries;
      const entries = await fetchEntries(call, instanceId, kind, scope);
      if (typeof entries === 'string') return entries;
      if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
      cache.set(key, { entries, expiresAt: now() + CACHE_TTL_MS });
      return entries;
    },
  };
}

/** For tests. */
export function resetDirectoryCache(): void {
  cache.clear();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function label(kind: RefKind): string {
  return kind.replace(/_/g, ' ');
}

function candidates(entries: RefEntry[]): string {
  const names = entries.slice(0, 25).map((entry) => `"${entry.name}"`);
  const more = entries.length > 25 ? `, … (${entries.length - 25} more)` : '';
  return names.length ? ` Known: ${names.join(', ')}${more}.` : '';
}

/**
 * One reference to one id. An exact id wins; then an exact name; then a
 * case-insensitive name; a miss re-reads the directory once. A UUID that
 * matches nothing passes through (it may be newer than any listing);
 * anything else that matches nothing, or matches several, is refused with
 * what exists.
 */
export async function resolveRef(
  directory: Directory,
  instanceId: string,
  kind: RefKind,
  ref: string | number,
  scope: RefScope = {}
): Promise<
  { ok: true; id: string | number; name: string | null } | { ok: false; message: string }
> {
  if (typeof ref === 'number') return { ok: true, id: ref, name: null };
  const wanted = ref.trim();
  if (!wanted) return { ok: false, message: `A ${label(kind)} id or name is required.` };
  if (INTEGER_KINDS.has(kind) && /^\d+$/.test(wanted)) {
    return { ok: true, id: Number(wanted), name: null };
  }

  const attempt = async (fresh: boolean) => {
    const entries = await directory.entries(instanceId, kind, scope, fresh);
    if (typeof entries === 'string') return entries;
    const byId = entries.find((entry) => entry.id === wanted);
    if (byId) return byId;
    const exact = entries.filter((entry) => entry.name === wanted);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return exact;
    const folded = entries.filter((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
    if (folded.length === 1) return folded[0];
    if (folded.length > 1) return folded;
    return null;
  };

  let found = await attempt(false);
  if (found === null) found = await attempt(true);
  if (typeof found === 'string') return { ok: false, message: found };
  if (found === null) {
    if (UUID.test(wanted)) return { ok: true, id: wanted, name: null };
    const entries = await directory.entries(instanceId, kind, scope);
    return {
      ok: false,
      message:
        `No ${label(kind)} named "${wanted}" on this instance.` +
        (typeof entries === 'string' ? '' : candidates(entries)),
    };
  }
  if (Array.isArray(found)) {
    return {
      ok: false,
      message:
        `"${wanted}" names ${found.length} ${label(kind)}s — give the id instead: ` +
        found.map((entry) => `${entry.name} = ${entry.id}`).join('; '),
    };
  }
  const id = INTEGER_KINDS.has(kind) && /^\d+$/.test(found.id) ? Number(found.id) : found.id;
  return { ok: true, id, name: found.name };
}

/**
 * Resolve every reference argument of a call in place. `channelId` is
 * resolved first so connector names can be looked up on the right channel.
 */
export async function resolveArgs(
  directory: Directory,
  instanceId: string,
  args: Record<string, unknown>
): Promise<{ ok: true; args: Record<string, unknown> } | { ok: false; message: string }> {
  const resolved: Record<string, unknown> = { ...args };
  const order = Object.keys(REF_ARGS).sort((a, b) =>
    a === 'channelId' ? -1 : b === 'channelId' ? 1 : 0
  );
  for (const name of order) {
    const value = resolved[name];
    if (value === undefined || value === null || value === '') continue;
    const kind = REF_ARGS[name];
    const scope: RefScope =
      kind === 'connector' && typeof resolved.channelId === 'string'
        ? { channelId: resolved.channelId }
        : {};
    if (Array.isArray(value)) {
      const ids: (string | number)[] = [];
      for (const item of value) {
        if (typeof item !== 'string' && typeof item !== 'number') continue;
        const one = await resolveRef(directory, instanceId, kind, item, scope);
        if (!one.ok) return one;
        ids.push(one.id);
      }
      resolved[name] = ids;
    } else if (typeof value === 'string' || typeof value === 'number') {
      const one = await resolveRef(directory, instanceId, kind, value, scope);
      if (!one.ok) return one;
      resolved[name] = one.id;
    }
  }
  return { ok: true, args: resolved };
}

/**
 * An instance reference — id, name, or environment label — against the
 * caller's connected instances. Names and labels fold case; a label two
 * instances share is ambiguous and says so.
 */
export function resolveInstanceRef(
  connected: ConnectedInstance[],
  ref: unknown
): { ok: true; id: string } | { ok: false; message: string } {
  const wanted = str(ref).trim();
  if (!wanted) return { ok: false, message: 'instanceId is required (from mirth_list_instances).' };
  const byId = connected.find((entry) => entry.instance.id === wanted);
  if (byId) return { ok: true, id: byId.instance.id };
  const folded = wanted.toLowerCase();
  for (const pick of [
    connected.filter((entry) => entry.instance.name === wanted),
    connected.filter((entry) => entry.instance.name.toLowerCase() === folded),
    connected.filter((entry) => entry.instance.environment.toLowerCase() === folded),
  ]) {
    if (pick.length === 1) return { ok: true, id: pick[0].instance.id };
    if (pick.length > 1) {
      return {
        ok: false,
        message:
          `"${wanted}" matches ${pick.length} connected instances — give the id or the name: ` +
          pick
            .map(
              (entry) =>
                `${entry.instance.name} [${entry.instance.environment}] = ${entry.instance.id}`
            )
            .join('; '),
      };
    }
  }
  return {
    ok: false,
    message:
      `No connected Mirth instance is called "${wanted}".` +
      (connected.length
        ? ` Connected: ${connected.map((entry) => `${entry.instance.name} [${entry.instance.environment}]`).join(', ')}.`
        : ' mirth_list_instances shows what is connected.'),
  };
}

/** The kinds whose ids are UUIDs and so can be recognised inside free text. */
const LEGEND_KINDS: readonly RefKind[] = [
  'channel',
  'alert',
  'channel_group',
  'channel_tag',
  'code_template_library',
  'code_template',
  'resource',
];
const MAX_LEGEND = 50;

/**
 * A legend for the UUIDs a piece of text mentions: `id — kind "name"`, one
 * line each, for the ids the directory knows whose name is not already in
 * the text. Empty when there is nothing to add. Directory failures are
 * swallowed: a legend is a courtesy, never a reason to fail an answer.
 */
export async function legendFor(
  directory: Directory,
  instanceId: string,
  text: string
): Promise<string> {
  const seen = new Set<string>();
  for (const match of text.matchAll(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
  )) {
    seen.add(match[0].toLowerCase());
  }
  if (seen.size === 0) return '';
  const lines: string[] = [];
  for (const kind of LEGEND_KINDS) {
    const entries = await directory.entries(instanceId, kind);
    if (typeof entries === 'string') continue;
    for (const entry of entries) {
      const id = entry.id.toLowerCase();
      if (!seen.has(id) || text.includes(entry.name)) continue;
      seen.delete(id);
      lines.push(`${entry.id} — ${label(kind)} "${entry.name}"`);
      if (lines.length >= MAX_LEGEND) break;
    }
    if (seen.size === 0 || lines.length >= MAX_LEGEND) break;
  }
  return lines.length ? `\n\nIds in this answer:\n${lines.join('\n')}` : '';
}

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: true;
  structuredContent?: Record<string, unknown>;
};
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;
type RegisterToolArgs = Parameters<McpServer['registerTool']>;

export interface ResolutionDeps {
  /** The caller's connected instances, fresh per call; a string is a refusal. */
  listConnected(): Promise<ConnectedInstance[] | string>;
  directory: Directory;
}

/**
 * Wrap a server so every tool registered through it resolves its
 * references before its handler runs and gets a legend after. The
 * handler still receives ids — it never has to know a name was given.
 */
export function withReferenceResolution(server: McpServer, deps: ResolutionDeps): McpServer {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property === 'registerTool') {
        return (...registration: RegisterToolArgs) => {
          const [name, config, handler] = registration;
          const wrapped: Handler = async (rawArgs: Record<string, unknown>) => {
            let args = rawArgs;
            if ('instanceId' in args) {
              const connected = await deps.listConnected();
              if (typeof connected === 'string') {
                return {
                  content: [{ type: 'text' as const, text: connected }],
                  isError: true as const,
                };
              }
              const instance = resolveInstanceRef(connected, args.instanceId);
              if (!instance.ok) {
                return {
                  content: [{ type: 'text' as const, text: instance.message }],
                  isError: true as const,
                };
              }
              const refs = await resolveArgs(deps.directory, instance.id, {
                ...args,
                instanceId: instance.id,
              });
              if (!refs.ok) {
                return {
                  content: [{ type: 'text' as const, text: refs.message }],
                  isError: true as const,
                };
              }
              args = refs.args;
            }
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the SDK's handler signature is generic over the schema; every tool here takes a plain record
            const result = await (handler as unknown as Handler)(args);
            if (result.isError || !result.content?.length || typeof args.instanceId !== 'string') {
              return result;
            }
            const first = result.content[0];
            if (first.type !== 'text') return result;
            const legend = await legendFor(deps.directory, args.instanceId, first.text);
            if (!legend) return result;
            return {
              ...result,
              content: [{ ...first, text: `${first.text}${legend}` }, ...result.content.slice(1)],
            };
          };
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- see above
          return target.registerTool(name, config, wrapped as unknown as RegisterToolArgs[2]);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
