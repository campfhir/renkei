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
  /** Valid option values for select/option fields (fetched from createmeta). */
  allowedValues?: FieldOption[] | undefined;
}

export interface FieldOption {
  value: string;
  id?: string | undefined;
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
  enrichmentCache.clear();
  requestTypeCache.clear();
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
    logger.debug('Loaded', {
      component: 'jira/field-schema',
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
    message: `No field matches "${wanted}". Call jira_list_fields to see what this site has.`,
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

/**
 * The JSM Request Type field (`com.atlassian.servicedesk:vp-origin`).
 *
 * Its wire format is the request-type ID — a display name 400s — so unlike
 * every other option-shaped field it cannot be passed through and left to
 * Jira: the name has to be resolved to the ID first.
 */
export function isRequestTypeField(field: JiraField): boolean {
  return field.type === 'sd-customerrequesttype' || (field.customType ?? '').endsWith(':vp-origin');
}

/** A field whose valid values are an enumerable option set worth fetching. */
function isOptionBearing(field: JiraField): boolean {
  return (
    field.type === 'option' ||
    field.type === 'option-with-child' ||
    isRequestTypeField(field) ||
    (field.type === 'array' && field.itemType === 'option')
  );
}

/** How many options a mismatch message shows before pointing at the tools. */
const OPTIONS_PREVIEW_LIMIT = 20;

/**
 * The field's valid options, phrased for the caller's retry. This is the
 * whole point of fetching allowed values: a mismatch that answers "then
 * what?" costs one round trip; an opaque 400 costs a whole investigation.
 */
export function optionsHint(field: JiraField): string {
  const options = field.allowedValues ?? [];
  if (options.length === 0) return '';
  const shown = options
    .slice(0, OPTIONS_PREVIEW_LIMIT)
    .map((opt) =>
      opt.id && opt.id !== opt.value ? `"${opt.value}" (id ${opt.id})` : `"${opt.value}"`
    )
    .join(', ');
  const more =
    options.length > OPTIONS_PREVIEW_LIMIT
      ? `, +${options.length - OPTIONS_PREVIEW_LIMIT} more (jsm_list_request_types / jsm_get_request_type_fields show the full set)`
      : '';
  return `Valid options: ${shown}${more}.`;
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

  // Also before the switch: Request Type's own type string would land in the
  // pass-through default, sending a display name Jira refuses.
  if (isRequestTypeField(field)) return requestTypeValue(field, value);

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
      return validateOptionValue(field, value);

    case 'option-with-child':
      // Both levels need ids or values the caller has to know; pass through.
      return isRecord(value)
        ? { ok: true, value }
        : { ok: false, message: `${field.name} needs {value, child} — see jira_list_fields` };

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

function validateOptionValue(field: JiraField, value: unknown): Coercion {
  // If already a record (structured value), pass through
  if (isRecord(value)) return { ok: true, value };

  const stringValue = String(value).trim();

  // If no allowed values are defined, we can't validate — pass through and let Jira validate
  if (!field.allowedValues || field.allowedValues.length === 0) {
    return { ok: true, value: { value: stringValue } };
  }

  // Check if the value matches any allowed option (case-insensitive for user-friendliness)
  const lowerStringValue = stringValue.toLowerCase();
  const match = field.allowedValues.find(
    (opt) =>
      opt.value.toLowerCase() === lowerStringValue ||
      (opt.id && opt.id.toLowerCase() === lowerStringValue)
  );

  if (match) {
    // The id when the options carry one — unambiguous where two options can
    // share a rendering — else the exact-case value from the option set.
    return { ok: true, value: match.id ? { id: match.id } : { value: match.value } };
  }

  return {
    ok: false,
    message: `${field.name} does not accept "${stringValue}". ${optionsHint(field)}`,
  };
}

/**
 * Resolve a Request Type reference to the bare request-type ID — the only
 * form the platform write API accepts for this field. A name is matched
 * against the enriched option set; a value that already looks like an ID
 * (matches an option's id, or no option set is known) goes through as-is.
 */
function requestTypeValue(field: JiraField, value: unknown): Coercion {
  if (isRecord(value)) return { ok: true, value };

  const text = String(value).trim();
  const options = field.allowedValues ?? [];

  // Nothing to check against: send the raw value. An ID works; a name fails
  // with Jira's own error, and the write fallback records the value.
  if (options.length === 0) return { ok: true, value: text };

  const lower = text.toLowerCase();
  const match = options.find(
    (opt) => (opt.id && opt.id.toLowerCase() === lower) || opt.value.toLowerCase() === lower
  );
  if (match) return { ok: true, value: match.id ?? match.value };

  return {
    ok: false,
    message: `${field.name} does not accept "${text}". ${optionsHint(field)}`,
  };
}

function userValue(field: JiraField, value: unknown): Coercion {
  if (isRecord(value)) return { ok: true, value };

  const text = String(value).trim();
  if (text.includes('@')) {
    return {
      ok: false,
      message: `${field.name} needs an account id, not an email. Call jira_search_users for "${text}".`,
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
      'This site has no Story Points field. Call jira_list_fields to see what it uses for estimation.',
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
  /**
   * Field id → "Valid options: …", for every option-bearing field whose
   * option set is known. Carried to the write fallback so that when Jira
   * refuses one of these fields anyway, the refusal names what would have
   * been accepted instead of leaving the caller to guess.
   */
  optionHints: Record<string, string>;
}

/** Where a write is headed, which decides where its allowed values live. */
export interface EnrichmentSource {
  /** Creating: createmeta needs the project. */
  projectKey?: string;
  /** Creating: the issue type NAME or id, matched against createmeta's list. */
  issueType?: string;
  /** Updating: editmeta answers for this exact issue, no type needed. */
  issueKey?: string;
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
  requested: Record<string, unknown>,
  options: EnrichmentSource = {}
): Promise<FieldUpdates> {
  const entries = Object.entries(requested);
  if (entries.length === 0) return { fields: {}, applied: [], problems: [], optionHints: {} };

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

  // Allowed values cost an extra round trip (createmeta or editmeta), so only
  // pay for it when a requested field actually carries an option set worth
  // validating before Jira sees it.
  const needsAllowedValues = entries.some(([reference]) => {
    const lookup = lookupField(schema, reference);
    return lookup.ok && isOptionBearing(lookup.field);
  });
  if (needsAllowedValues) {
    schema = await enrichFieldsWithAllowedValues(context, schema, options);

    // Request Type is often absent from create/edit meta (it is JSM's, not
    // the platform's) — the service-desk API is the fallback option source.
    const requestTypeUncovered = entries.some(([reference]) => {
      const lookup = lookupField(schema, reference);
      return lookup.ok && isRequestTypeField(lookup.field) && !lookup.field.allowedValues?.length;
    });
    if (requestTypeUncovered) {
      const requestTypes = await loadRequestTypeOptions(context);
      if (requestTypes.length > 0) {
        schema = schema.map((field) =>
          isRequestTypeField(field) && !field.allowedValues?.length
            ? { ...field, allowedValues: requestTypes }
            : field
        );
      }
    }
  }

  const fields: Record<string, unknown> = {};
  const applied: string[] = [];
  const problems: string[] = [];
  const optionHints: Record<string, string> = {};

  for (const [reference, value] of entries) {
    const lookup = lookupField(schema, reference);
    if (!lookup.ok) {
      problems.push(lookup.message);
      continue;
    }

    if (isOptionBearing(lookup.field)) {
      const hint = optionsHint(lookup.field);
      if (hint) optionHints[lookup.field.id] = hint;
    }

    const coerced = coerceFieldValue(lookup.field, value);
    if (!coerced.ok) {
      problems.push(coerced.message);
      continue;
    }

    fields[lookup.field.id] = coerced.value;
    applied.push(`${lookup.field.name} (${lookup.field.id})`);
  }

  return { fields, applied, problems, optionHints };
}

function schemaCacheAge(context: MCPToolContext): number | null {
  const cached = schemaCache.get(context.apiBaseUrl);
  return cached ? Date.now() - cached.fetchedAt : null;
}

/**
 * Allowed values track project configuration, not issue content — but they
 * are also per-project/per-issue, so they get their own short-lived cache
 * rather than riding on the day-long schema cache.
 */
const ENRICHMENT_TTL_MS = 5 * 60 * 1000;
const enrichmentCache = new Map<
  string,
  { options: Record<string, FieldOption[]>; fetchedAt: number }
>();

function parseOption(opt: unknown): FieldOption {
  const record = isRecord(opt) ? opt : {};
  // Selects carry `value`; request types, versions and components carry
  // `name`. Reading only `value` is how Request Type options came out as
  // "[object Object]".
  const value =
    typeof record.value === 'string'
      ? record.value
      : typeof record.name === 'string'
        ? record.name
        : String(opt);
  const id =
    typeof record.id === 'string'
      ? record.id
      : typeof record.id === 'number'
        ? String(record.id)
        : undefined;
  return { value, id };
}

function collectAllowedValues(
  target: Record<string, FieldOption[]>,
  fieldsMeta: Record<string, unknown>
): void {
  for (const [fieldId, fieldMeta] of Object.entries(fieldsMeta)) {
    if (!isRecord(fieldMeta)) continue;
    const allowedValues = fieldMeta.allowedValues;
    if (Array.isArray(allowedValues) && allowedValues.length > 0) {
      target[fieldId] = allowedValues.map(parseOption);
    }
  }
}

/**
 * Fetch allowed values for option-bearing fields.
 *
 * An update reads editmeta — the answer for that exact issue, no issue type
 * needed. A create reads createmeta filtered to the project, matching the
 * caller's issue type by NAME or id against the response (the old code sent
 * the name where the API wanted ids, which silently filtered to nothing).
 *
 * Failures fall back to unenriched fields; option values then pass through
 * for Jira to validate.
 */
export async function enrichFieldsWithAllowedValues(
  context: MCPToolContext,
  fields: JiraField[],
  source: EnrichmentSource = {}
): Promise<JiraField[]> {
  const cacheKey = source.issueKey
    ? `${context.apiBaseUrl}|edit|${source.issueKey}`
    : `${context.apiBaseUrl}|create|${source.projectKey ?? ''}|${(source.issueType ?? '').toLowerCase()}`;

  const cached = enrichmentCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < ENRICHMENT_TTL_MS) {
    return mergeAllowedValues(fields, cached.options);
  }

  try {
    const allowedValuesByFieldId: Record<string, FieldOption[]> = {};

    if (source.issueKey) {
      const response = await jiraFetch(
        `${context.apiBaseUrl}/rest/api/3/issue/${encodeURIComponent(source.issueKey)}/editmeta`,
        context.accessToken
      );
      const metadata = await response.json();
      if (isRecord(metadata) && isRecord(metadata.fields)) {
        collectAllowedValues(allowedValuesByFieldId, metadata.fields);
      }
    } else {
      const params: string[] = [];
      if (source.projectKey) params.push(`projectKeys=${encodeURIComponent(source.projectKey)}`);
      params.push('expand=projects.issuetypes.fields');
      const response = await jiraFetch(
        `${context.apiBaseUrl}/rest/api/3/issue/createmeta?${params.join('&')}`,
        context.accessToken
      );
      const metadata = await response.json();

      const wanted = source.issueType?.trim().toLowerCase();
      if (isRecord(metadata) && Array.isArray(metadata.projects)) {
        for (const projectData of metadata.projects) {
          if (!isRecord(projectData) || !Array.isArray(projectData.issuetypes)) continue;
          for (const issueTypeData of projectData.issuetypes) {
            if (!isRecord(issueTypeData) || !isRecord(issueTypeData.fields)) continue;
            if (wanted) {
              const name = typeof issueTypeData.name === 'string' ? issueTypeData.name : '';
              const id = typeof issueTypeData.id === 'string' ? issueTypeData.id : '';
              if (name.toLowerCase() !== wanted && id !== wanted) continue;
            }
            collectAllowedValues(allowedValuesByFieldId, issueTypeData.fields);
          }
        }
      }
    }

    enrichmentCache.set(cacheKey, { options: allowedValuesByFieldId, fetchedAt: Date.now() });
    return mergeAllowedValues(fields, allowedValuesByFieldId);
  } catch (error) {
    logger.debug('Error enriching fields with allowed values', {
      component: 'jira/field-schema',
      error: error instanceof Error ? error.message : String(error),
    });
    // Gracefully return fields without allowed values
    return fields;
  }
}

function mergeAllowedValues(
  fields: JiraField[],
  options: Record<string, FieldOption[]>
): JiraField[] {
  return fields.map((field) => ({
    ...field,
    allowedValues: options[field.id] || field.allowedValues,
  }));
}

/** Request types straight from JSM, when create/edit meta had none. */
const requestTypeCache = new Map<string, { options: FieldOption[]; fetchedAt: number }>();

async function loadRequestTypeOptions(context: MCPToolContext): Promise<FieldOption[]> {
  const cached = requestTypeCache.get(context.apiBaseUrl);
  if (cached && Date.now() - cached.fetchedAt < ENRICHMENT_TTL_MS) return cached.options;

  try {
    // The cross-service-desk listing, so no serviceDeskId is needed here.
    // Requires JSM scopes on the grant; without them this lands in the catch
    // and the value passes through for Jira to name the problem.
    const response = await jiraFetch(
      `${context.apiBaseUrl}/rest/servicedeskapi/requesttype`,
      context.accessToken
    );
    const payload = await response.json();
    const values = isRecord(payload) && Array.isArray(payload.values) ? payload.values : [];
    const options = values
      .map((entry) => {
        if (!isRecord(entry)) return null;
        const name = typeof entry.name === 'string' ? entry.name : null;
        const id =
          typeof entry.id === 'string'
            ? entry.id
            : typeof entry.id === 'number'
              ? String(entry.id)
              : null;
        return name && id ? { value: name, id } : null;
      })
      .filter((option): option is FieldOption & { id: string } => option !== null);

    requestTypeCache.set(context.apiBaseUrl, { options, fetchedAt: Date.now() });
    return options;
  } catch (error) {
    logger.debug('Could not list request types for field resolution', {
      component: 'jira/field-schema',
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
