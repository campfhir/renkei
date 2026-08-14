/**
 * Which fields actually belong on an issue — per project and issue type.
 *
 * Jira will happily return a value for a field that is not on the project's
 * screen. Values linger after a project is reconfigured or an issue is moved,
 * and `*navigable` reports them all, so an issue whose form has no "Type of
 * Engagement" gets indexed as having one. The site-wide `/rest/api/3/field`
 * list cannot tell you this: it knows every field that exists, not which ones
 * apply here.
 *
 * WHY EDIT METADATA, AND WHY IT IS CACHEABLE. `editmeta` is documented per
 * issue, which would mean one call per issue — impossible across tens of
 * thousands. But it is identical for every issue sharing a project and issue
 * type: verified on a live instance across issues in different statuses,
 * since a status-scoped screen would have broken exactly that assumption. So
 * one issue is sampled per combination and the answer is cached.
 *
 * Edit metadata rather than create metadata, which was the other candidate:
 * create omits fields that exist on the issue but not the create form. On a
 * real instance that included Request participants for incidents — the field
 * whose absence prompted this in the first place.
 *
 * WHAT IT DOES NOT COVER. Edit metadata describes what can be EDITED, so it
 * carries no status, resolution, created, updated or time tracking. Callers
 * filtering against it must exempt read-only system fields, or they will
 * delete the spine of whatever they are building.
 *
 * CREATING IS A DIFFERENT SCREEN. Jira configures create and edit separately,
 * and they genuinely differ — on a live instance the edit screen carried
 * Request participants and Request Type where create did not, and create
 * carried `project` and `issuetype` where edit did not, because by then they
 * are decided. So `createScreenFor` exists beside `fieldScreenFor`, and a
 * caller building a create payload must use it: validating new-issue fields
 * against the edit screen would accept fields the create form will reject.
 */

import { atlassianFetch, listOf, rec, str } from './client';

/** One field as this project and issue type present it. */
export interface EditableField {
  id: string;
  /** The name the team sees, which is what a person will say to a model. */
  name: string;
  required: boolean;
  /** `string`, `user`, `option`, `array`… — from the field's schema. */
  schemaType: string | null;
  custom: boolean;
  /** Options for a select-style field, already flattened to their labels. */
  allowedValues: string[];
  /** `set`, `add`, `remove` — what an update may do to it. */
  operations: string[];
}

export interface FieldScreen {
  projectKey: string;
  issueTypeId: string;
  fields: ReadonlyMap<string, EditableField>;
  /** Custom-field ids alone — what a document builder needs to filter on. */
  customFieldIds: ReadonlySet<string>;
}

/**
 * Ten minutes: long enough that a sweep of thousands of issues pays for one
 * lookup per combination, short enough that an admin adding a field to a
 * screen sees it without a restart.
 */
const CACHE_TTL_MS = 10 * 60_000;

interface CacheEntry {
  screen: FieldScreen | null;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<FieldScreen | null>>();

/** Shared by both screens; `kind` keeps create and edit from colliding. */
async function cached(
  key: string,
  load: () => Promise<FieldScreen | null>
): Promise<FieldScreen | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.screen;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const fetching = load()
    .then((screen) => {
      cache.set(key, { screen, fetchedAt: Date.now() });
      return screen;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, fetching);
  return fetching;
}

/** For tests, and for an admin who has just changed a screen. */
export function clearFieldScreenCache(): void {
  cache.clear();
  inFlight.clear();
}

function screenOf(
  projectKey: string,
  issueTypeId: string,
  fields: Map<string, EditableField>
): FieldScreen {
  return {
    projectKey,
    issueTypeId,
    fields,
    customFieldIds: new Set([...fields.keys()].filter((id) => id.startsWith('customfield_'))),
  };
}

function parseField(id: string, raw: Record<string, unknown>): EditableField {
  const schema = rec(raw.schema);
  const allowed = Array.isArray(raw.allowedValues) ? raw.allowedValues : [];
  return {
    id,
    name: str(raw.name) || id,
    required: raw.required === true,
    schemaType: str(schema.type) || null,
    custom: id.startsWith('customfield_'),
    allowedValues: allowed
      .map((option) => {
        const record = rec(option);
        return str(record.value) || str(record.name) || '';
      })
      .filter(Boolean),
    operations: Array.isArray(raw.operations)
      ? raw.operations.filter((op): op is string => typeof op === 'string')
      : [],
  };
}

/**
 * The screen for one project and issue type, or null when it cannot be read.
 *
 * `issueKey` is a SAMPLE — any issue of that project and issue type gives the
 * same answer, and the result is cached under the combination rather than the
 * issue.
 *
 * Null on failure rather than throwing: a caller that cannot read the screen
 * should fall back to keeping everything. Quietly dropping fields because a
 * metadata call failed is the wrong way to be wrong.
 */
export async function fieldScreenFor(params: {
  cloudId: string;
  accessToken: string;
  issueKey: string;
  projectKey: string;
  issueTypeId: string;
}): Promise<FieldScreen | null> {
  const { cloudId, accessToken, issueKey, projectKey, issueTypeId } = params;
  if (!projectKey || !issueTypeId || !issueKey) return null;

  return cached(`edit/${cloudId}/${projectKey}/${issueTypeId}`, async () => {
    const response = await atlassianFetch({
      product: 'jira',
      cloudId,
      accessToken,
      path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}/editmeta`,
      // A person may be waiting on this through a tool call.
      lane: 'interactive',
    });
    if (!response.ok) return null;

    const raw = rec(response.body.fields);
    const fields = new Map<string, EditableField>();
    for (const [id, value] of Object.entries(raw)) {
      fields.set(id, parseField(id, rec(value)));
    }
    return screenOf(projectKey, issueTypeId, fields);
  });
}

/**
 * The CREATE screen for a project and issue type.
 *
 * Needs no sample issue — there is no issue yet, which is the whole point.
 * Use this when building a create payload; the edit screen would accept
 * fields the create form rejects and omit ones it requires.
 */
export async function createScreenFor(params: {
  cloudId: string;
  accessToken: string;
  projectKey: string;
  issueTypeId: string;
}): Promise<FieldScreen | null> {
  const { cloudId, accessToken, projectKey, issueTypeId } = params;
  if (!projectKey || !issueTypeId) return null;

  return cached(`create/${cloudId}/${projectKey}/${issueTypeId}`, async () => {
    const response = await atlassianFetch({
      product: 'jira',
      cloudId,
      accessToken,
      // maxResults because this endpoint pages its fields; a create screen
      // with more than 200 is not a thing anyone has built on purpose.
      path:
        `/rest/api/3/issue/createmeta/${encodeURIComponent(projectKey)}` +
        `/issuetypes/${encodeURIComponent(issueTypeId)}?maxResults=200`,
      lane: 'interactive',
    });
    if (!response.ok) return null;

    // Createmeta returns an ARRAY carrying `fieldId`, where editmeta returns
    // an object keyed by id. Same idea, different shape.
    const fields = new Map<string, EditableField>();
    for (const entry of listOf(response.body, 'fields')) {
      const id = str(entry.fieldId) || str(entry.key);
      if (id) fields.set(id, parseField(id, entry));
    }
    return screenOf(projectKey, issueTypeId, fields);
  });
}

/** Resolve a field by id or by the name a person used, case-insensitively. */
export function fieldByReference(screen: FieldScreen, reference: string): EditableField | null {
  const direct = screen.fields.get(reference);
  if (direct) return direct;
  const wanted = reference.trim().toLowerCase();
  for (const field of screen.fields.values()) {
    if (field.name.toLowerCase() === wanted) return field;
  }
  return null;
}
