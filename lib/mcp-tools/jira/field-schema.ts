/**
 * The site's field schema, and what it takes to write to a field.
 *
 * Custom fields are the reason this exists. `customfield_10016` means nothing
 * on its own — it is Story Points on one site, a sprint reference on another —
 * and its id differs per instance, so nothing may hardcode one. /rest/api/3/field
 * answers both halves: which id a name refers to, and the JSON shape a write to
 * it has to take, since a number field wants `5` and a select field wants
 * `{ value: "Approved" }` and sending one where the other belongs is a 400 at
 * best and the wrong data at worst.
 *
 * The schema is cached for a day. It describes the site's configuration, which
 * changes when an administrator adds a field, not when an issue changes, so
 * re-fetching per call would spend a round trip on an answer that is almost
 * always the same. A name that fails to resolve refreshes it once — that is
 * exactly the case where the cache is the thing that is stale.
 */

import { jiraFetch } from '../common';
import type { MCPToolContext } from '../common';
import { logger } from '@/lib/logger';
import { adfToMarkdown } from './adf';
import { normalizeFieldId, renderFieldValue } from './fields';
import { markdownToAdf } from './markdown';

export interface JiraField {
  /** `summary`, `customfield_10016`. What the REST payload is keyed by. */
  id: string;
  /** `Story Points`. What a person calls it. */
  name: string;
  custom: boolean;
  /** `schema.type`: number, string, option, array, user, date, timetracking… */
  type: string;
  /** `schema.items` for an array field — the type of one member. */
  itemType?: string | undefined;
  /**
   * `schema.custom`, the plugin key of a custom field.
   *
   * Needed because `type` alone does not say whether a field takes rich text.
   * Jira reports a multi-line text custom field as `type: "string"` while its
   * write API requires an Atlassian Document, so the plugin key is the only
   * thing that distinguishes it from a field that really does take a string.
   */
  customType?: string | undefined;
  /** The JQL spellings, which include `cf[10016]`. */
  clauseNames: string[];
}

/** How long the schema is trusted. It tracks configuration, not content. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How stale the schema must be before an unresolvable name is allowed to force a
 * refetch. Without this, a caller repeatedly asking for a field that genuinely
 * does not exist would refetch on every attempt.
 */
const REFRESH_GRACE_MS = 60 * 1000;

interface CacheEntry {
  fields: JiraField[];
  fetchedAt: number;
}

/**
 * Keyed by API base, which carries the cloudId — the schema belongs to the site,
 * not to the tenant or the user, so two users of one site share an entry.
 */
const schemaCache = new Map<string, CacheEntry>();

/** In-flight fetches, so concurrent tool calls make one request between them. */
const inFlight = new Map<string, Promise<JiraField[]>>();

/** Reset the cache. For tests, and for a caller that knows it just added a field. */
export function clearFieldSchemaCache(): void {
  schemaCache.clear();
  inFlight.clear();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function parseField(raw: unknown): JiraField | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') return null;

  const schema = isRecord(raw.schema) ? raw.schema : {};

  return {
    id: raw.id,
    name: raw.name,
    custom: raw.custom === true,
    type: typeof schema.type === 'string' ? schema.type : 'any',
    itemType: typeof schema.items === 'string' ? schema.items : undefined,
    customType: typeof schema.custom === 'string' ? schema.custom : undefined,
    clauseNames: Array.isArray(raw.clauseNames)
      ? raw.clauseNames.filter((name): name is string => typeof name === 'string')
      : [],
  };
}

export async function loadFieldSchema(
  context: MCPToolContext,
  options: { refresh?: boolean } = {}
): Promise<JiraField[]> {
  const key = context.apiBaseUrl;
  const cached = schemaCache.get(key);

  if (!options.refresh && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.fields;
  }

  const pending = inFlight.get(key);
  if (pending && !options.refresh) return pending;

  const fetching = (async () => {
    const response = await jiraFetch(`${context.apiBaseUrl}/rest/api/3/field`, context.accessToken);
    const payload = await response.json();
    const fields = Array.isArray(payload)
      ? payload.map(parseField).filter((field): field is JiraField => field !== null)
      : [];

    schemaCache.set(key, { fields, fetchedAt: Date.now() });
    logger.debug('[FieldSchema] Loaded', {
      tenantId: context.tenantId,
      accountId: context.accountId,
      fields: fields.length,
    });
    return fields;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, fetching);
  return fetching;
}

export type FieldLookup =
  { ok: true; field: JiraField } | { ok: false; reason: 'unknown' | 'ambiguous'; message: string };

/**
 * Find the field a caller named.
 *
 * Ids and JQL spellings first, since those are unambiguous, then the exact
 * display name, then a unique partial match. A partial match that hits more than
 * one field is refused rather than guessed: writing story points into a field
 * called "Story Points (old)" is not a mistake worth making silently.
 */
export function lookupField(fields: readonly JiraField[], reference: string): FieldLookup {
  const wanted = reference.trim();
  if (wanted.length === 0) {
    return { ok: false, reason: 'unknown', message: 'Empty field reference' };
  }

  const asId = normalizeFieldId(wanted).toLowerCase();
  const byId = fields.find((field) => field.id.toLowerCase() === asId);
  if (byId) return { ok: true, field: byId };

  const lower = wanted.toLowerCase();
  const byClause = fields.find((field) =>
    field.clauseNames.some((clause) => clause.toLowerCase() === lower)
  );
  if (byClause) return { ok: true, field: byClause };

  const byName = fields.filter((field) => field.name.toLowerCase() === lower);
  if (byName.length === 1) return { ok: true, field: byName[0]! };
  if (byName.length > 1)
    return { ok: false, reason: 'ambiguous', message: ambiguous(wanted, byName) };

  const partial = fields.filter((field) => field.name.toLowerCase().includes(lower));
  if (partial.length === 1) return { ok: true, field: partial[0]! };
  if (partial.length > 1) {
    return { ok: false, reason: 'ambiguous', message: ambiguous(wanted, partial) };
  }

  return {
    ok: false,
    reason: 'unknown',
    message: `No field matches "${wanted}". Call list_fields to see what this site has.`,
  };
}

function ambiguous(reference: string, candidates: readonly JiraField[]): string {
  const named = candidates
    .slice(0, 6)
    .map((field) => `${field.name} (${field.id})`)
    .join(', ');
  return `"${reference}" matches more than one field: ${named}. Use the field id.`;
}

/**
 * Custom field types whose values are Atlassian Documents.
 *
 * `textarea` is the multi-line text field, which Jira describes as
 * `type: "string"` and then refuses to accept a string for: "Operation value
 * must be an Atlassian Document". Treating those two facts as one is what this
 * list is for.
 */
const RICH_TEXT_CUSTOM_TYPES = [':textarea'];

/** Does this field hold an Atlassian Document, whatever its `type` claims? */
export function isRichTextField(field: JiraField): boolean {
  if (field.type === 'doc') return true;
  const custom = field.customType ?? '';
  return RICH_TEXT_CUSTOM_TYPES.some((suffix) => custom.endsWith(suffix));
}

export type Coercion = { ok: true; value: unknown } | { ok: false; message: string };

/** True for something already shaped as an Atlassian Document. */
function isAdfDocument(value: unknown): boolean {
  return isRecord(value) && value.type === 'doc' && Array.isArray(value.content);
}

/**
 * Turn whatever arrived into an Atlassian Document.
 *
 * A string is read as markdown, which is what the write tools accept
 * everywhere else. A document passes through. An ADF fragment — a bare
 * paragraph, or a node copied out of another issue — is flattened and rebuilt
 * so the result is a whole document rather than something Jira half-accepts.
 */
function richTextValue(value: unknown): Coercion {
  if (isAdfDocument(value)) return { ok: true, value };
  if (typeof value === 'string') return { ok: true, value: markdownToAdf(value) };

  if (isRecord(value)) {
    // renderFieldValue handles ADF nodes, option objects and users alike, so a
    // value copied from a read of another issue keeps its text either way.
    const text = renderFieldValue(value) || adfToMarkdown(value);
    if (text) return { ok: true, value: markdownToAdf(text) };
  }

  if (value === undefined) return { ok: true, value: null };
  return { ok: true, value: markdownToAdf(String(value)) };
}

/**
 * A string for a field that genuinely wants one.
 *
 * Never `String(value)` on an object: that is where "[object Object]" came
 * from, and it reached Jira as the field's new contents.
 */
function plainStringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value) || Array.isArray(value))
    return renderFieldValue(value) || JSON.stringify(value);
  return String(value);
}

/**
 * Put a plain value into the shape the field's schema type requires.
 *
 * A model writing `{"Story Points": 5}` should not have to know that a select
 * field needs `{value: …}` while a number field needs the bare number. What it
 * cannot do is guess an account id, so a user field asks for one explicitly
 * instead of sending an email address that Jira silently ignores.
 */
export function coerceFieldValue(field: JiraField, value: unknown): Coercion {
  // Clearing a field is a legitimate update, and null is how Jira spells it.
  if (value === null) return { ok: true, value: null };

  // Before the switch: a rich-text field reports `type: "string"`, so matching
  // on type alone sends a string to a field that only accepts a document.
  if (isRichTextField(field)) return richTextValue(value);

  switch (field.type) {
    case 'number': {
      const asNumber = typeof value === 'number' ? value : Number(String(value).trim());
      if (!Number.isFinite(asNumber)) {
        return { ok: false, message: `${field.name} takes a number, got ${describe(value)}` };
      }
      return { ok: true, value: asNumber };
    }

    case 'string':
      return { ok: true, value: plainStringValue(value) };

    case 'option':
      return isRecord(value) ? { ok: true, value } : { ok: true, value: { value: String(value) } };

    case 'option-with-child':
      // Both levels need ids or values the caller has to know; pass through.
      return isRecord(value)
        ? { ok: true, value }
        : { ok: false, message: `${field.name} needs {value, child} — see list_fields` };

    case 'user':
      return userValue(field, value);

    case 'array':
      return arrayValue(field, value);

    case 'date':
      return dateValue(field, value, /^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

    case 'datetime':
      return dateValue(field, value, /^\d{4}-\d{2}-\d{2}T/, 'an ISO-8601 timestamp');

    case 'timetracking':
      if (isRecord(value)) return { ok: true, value };
      return { ok: true, value: { originalEstimate: String(value) } };

    default:
      // `any` and the field types this does not model: send it as given rather
      // than refuse. Jira validates, and its error names the field.
      return { ok: true, value };
  }
}

function userValue(field: JiraField, value: unknown): Coercion {
  if (isRecord(value)) return { ok: true, value };

  const text = String(value).trim();
  if (text.includes('@')) {
    return {
      ok: false,
      message: `${field.name} needs an account id, not an email. Call search_users for "${text}".`,
    };
  }
  return { ok: true, value: { accountId: text } };
}

function arrayValue(field: JiraField, value: unknown): Coercion {
  // A comma-separated string is how these get written in practice.
  const members = Array.isArray(value)
    ? value
    : String(value)
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);

  switch (field.itemType) {
    case 'string':
      return { ok: true, value: members.map((member) => plainStringValue(member)) };
    case 'option':
    case 'version':
    case 'component':
      return {
        ok: true,
        value: members.map((member) =>
          isRecord(member)
            ? member
            : { [field.itemType === 'option' ? 'value' : 'name']: String(member) }
        ),
      };
    case 'user':
      return {
        ok: true,
        value: members.map((member) => (isRecord(member) ? member : { accountId: String(member) })),
      };
    default:
      return { ok: true, value: members };
  }
}

function dateValue(field: JiraField, value: unknown, shape: RegExp, expected: string): Coercion {
  const text = String(value).trim();
  if (!shape.test(text)) {
    return { ok: false, message: `${field.name} takes ${expected}, got "${text}"` };
  }
  return { ok: true, value: text };
}

function describe(value: unknown): string {
  return typeof value === 'object' ? JSON.stringify(value) : `"${String(value)}"`;
}

/**
 * The names Story Points goes by. Team-managed projects call it "Story point
 * estimate" and company-managed ones "Story Points", and a site can have both —
 * which is why this resolves by name against the schema rather than assuming an
 * id, and prefers an exact hit before a partial one.
 */
const STORY_POINT_NAMES = ['story points', 'story point estimate', 'story points estimate'];

export function findStoryPointsField(fields: readonly JiraField[]): FieldLookup {
  for (const name of STORY_POINT_NAMES) {
    const exact = fields.filter((field) => field.name.toLowerCase() === name);
    if (exact.length === 1) return { ok: true, field: exact[0]! };
    if (exact.length > 1)
      return { ok: false, reason: 'ambiguous', message: ambiguous(name, exact) };
  }

  const partial = fields.filter((field) => /story\s*point/i.test(field.name));
  if (partial.length === 1) return { ok: true, field: partial[0]! };
  if (partial.length > 1) {
    return { ok: false, reason: 'ambiguous', message: ambiguous('story points', partial) };
  }

  return {
    ok: false,
    reason: 'unknown',
    message:
      'This site has no Story Points field. Call list_fields to see what it uses for estimation.',
  };
}

/** Jira durations: 2w 3d 4h 30m, in any combination. */
export function isJiraDuration(value: string): boolean {
  return /^(\d+(\.\d+)?[wdhm]\s*)+$/i.test(value.trim());
}

export interface FieldUpdates {
  /** Ready to merge into the `fields` object of an issue create or update. */
  fields: Record<string, unknown>;
  /** `Story Points (customfield_10016) → 5`, for the reply. */
  applied: string[];
  /** Names that did not resolve, or values that did not fit. */
  problems: string[];
}

/**
 * Resolve a map of field references to a REST payload.
 *
 * Refuses on the first unresolvable name rather than sending a partial update:
 * a caller told "3 of 4 fields were set" has to work out which, and a half-
 * applied planning session is worse than one that failed outright.
 */
export async function buildFieldUpdates(
  context: MCPToolContext,
  requested: Record<string, unknown>
): Promise<FieldUpdates> {
  const entries = Object.entries(requested);
  if (entries.length === 0) return { fields: {}, applied: [], problems: [] };

  let schema = await loadFieldSchema(context);

  // A name that does not resolve is the one case where the cache is the likely
  // culprit, so it earns a single refetch before being reported as unknown.
  const unresolved = entries.filter(([reference]) => !lookupField(schema, reference).ok);
  if (unresolved.length > 0) {
    const entry = schemaCacheAge(context);
    if (entry === null || entry > REFRESH_GRACE_MS) {
      schema = await loadFieldSchema(context, { refresh: true });
    }
  }

  const fields: Record<string, unknown> = {};
  const applied: string[] = [];
  const problems: string[] = [];

  for (const [reference, value] of entries) {
    const lookup = lookupField(schema, reference);
    if (!lookup.ok) {
      problems.push(lookup.message);
      continue;
    }

    const coerced = coerceFieldValue(lookup.field, value);
    if (!coerced.ok) {
      problems.push(coerced.message);
      continue;
    }

    fields[lookup.field.id] = coerced.value;
    applied.push(`${lookup.field.name} (${lookup.field.id})`);
  }

  return { fields, applied, problems };
}

function schemaCacheAge(context: MCPToolContext): number | null {
  const cached = schemaCache.get(context.apiBaseUrl);
  return cached ? Date.now() - cached.fetchedAt : null;
}
