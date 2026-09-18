/**
 * Components, for a service desk.
 *
 * ## Why JSM needs its own path to these at all
 *
 * A service desk request IS a Jira issue, and its project has components
 * like any other. But the servicedeskapi does not expose them, and it does
 * not accept arbitrary issue fields on create either: `requestFieldValues`
 * only carries fields that the REQUEST TYPE's own form declares. So there
 * are two different questions with two different answers, and conflating
 * them is how a component silently fails to land:
 *
 *   1. What components does this project have?  →  the platform API.
 *   2. What components can THIS request type set?  →  the request type's
 *      field metadata, which is authoritative and often a subset — or
 *      empty, when the form simply has no components field.
 *
 * (2) is the one that decides whether a create can carry them, so it is
 * what `jsm_create_request` resolves against, and it costs no scope beyond
 * the JSM read the caller already has. (1) is the fuller answer a person
 * usually means by "list the components", and it needs a Jira project
 * scope the JSM app has to be granted — hence `PROJECT_COMPONENT_READ`
 * below, and the fallback wording when a grant predates it.
 */

import { serviceDeskScopes, describeJsmAuthFailure, type JsmAuth } from './jsm-auth';

/**
 * The platform scope for reading a project's components.
 *
 * Cross-family, like `read:user:jira` already is in the JSM app: the
 * servicedeskapi genuinely cannot answer this one. A grant made before it
 * was added simply lacks it, and `JsmAuth.fetch` says so in words that name
 * the fix, which is why nothing here has to pre-check.
 */
export const PROJECT_COMPONENT_READ = 'read:project.component:jira';

/** A component as both APIs eventually describe it. */
export interface ComponentOption {
  id: string;
  name: string;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ResolvedDesk {
  id: string;
  projectKey: string;
}

/**
 * A service desk id or project key, resolved to the numeric id the write
 * endpoints insist on — plus the project key, which the platform component
 * listing needs and which the same response already carries.
 *
 * Models that used a key for `jsm_get_request_type_fields` pass it here too,
 * and `POST /request` answers a bare 400 for one. Resolving beats rejecting.
 */
export async function resolveServiceDesk(
  auth: JsmAuth,
  value: string
): Promise<{ ok: true; desk: ResolvedDesk } | { ok: false; message: string }> {
  const given = String(value).trim();
  if (!given) return { ok: false, message: 'serviceDeskId is required' };

  const response = await auth.fetch(
    serviceDeskScopes('jsm_list_service_desks', true),
    `/rest/servicedeskapi/servicedesk/${encodeURIComponent(given)}`
  );
  if (!response.ok) {
    return {
      ok: false,
      message:
        `Service desk "${given}" could not be resolved — ` +
        `jsm_list_service_desks shows every desk with its serviceDeskId.`,
    };
  }
  const desk: unknown = await response.json().catch(() => null);
  if (!isRecord(desk) || !str(desk.id)) {
    return { ok: false, message: `Service desk "${given}" answered without an id.` };
  }
  return { ok: true, desk: { id: str(desk.id), projectKey: str(desk.projectKey) } };
}

/** A request type as the desk lists it. */
export interface ResolvedRequestType {
  id: string;
  name: string;
}

/**
 * A request type id or NAME, resolved to the numeric id every request-type
 * endpoint insists on — the same posture `resolveServiceDesk` takes with a
 * project key, for the same reason.
 *
 * `jsm_list_request_types` shows "Application Error (ID: 42)", and a model
 * reading that naturally passes the name it just read. The API answers with
 * "Failed to convert 'requestTypeId'" — a 400 that reads like the payload
 * was malformed rather than like a lookup was skipped. Resolving beats
 * rejecting: a numeric id passes straight through with no call at all, and
 * a name costs one listing of the desk's types, matched case-insensitively.
 */
export async function resolveRequestType(
  auth: JsmAuth,
  deskId: string,
  value: string
): Promise<{ ok: true; requestType: ResolvedRequestType } | { ok: false; message: string }> {
  const given = String(value).trim();
  if (!given) return { ok: false, message: 'requestTypeId is required' };
  if (/^\d+$/.test(given)) return { ok: true, requestType: { id: given, name: '' } };

  const types = await listRequestTypes(auth, deskId);
  if (!types.ok) return types;

  const lower = given.toLowerCase();
  const match = types.requestTypes.find((entry) => entry.name.toLowerCase() === lower);
  if (match) return { ok: true, requestType: match };

  const known =
    types.requestTypes.length === 0
      ? 'the desk lists no request types at all'
      : `it has ${types.requestTypes.map((entry) => `${entry.name} (${entry.id})`).join(', ')}`;
  return {
    ok: false,
    message:
      `Request type "${given}" is not one service desk ${deskId} offers — ${known}. ` +
      `jsm_list_request_types shows each with its requestTypeId.`,
  };
}

/**
 * Every request type on a desk, id and name — all pages, because a desk
 * with more types than one page holds is exactly where a name lookup that
 * stops early would say "not found" about a type that exists.
 */
async function listRequestTypes(
  auth: JsmAuth,
  deskId: string
): Promise<{ ok: true; requestTypes: ResolvedRequestType[] } | { ok: false; message: string }> {
  const requestTypes: ResolvedRequestType[] = [];
  const limit = 100;
  let start = 0;
  for (;;) {
    const response = await auth.fetch(
      serviceDeskScopes('jsm_list_request_types', true),
      `/rest/servicedeskapi/servicedesk/${encodeURIComponent(deskId)}/requesttype` +
        `?start=${start}&limit=${limit}`
    );
    if (!response.ok) return { ok: false, message: await describeJsmAuthFailure(response) };

    const payload: unknown = await response.json().catch(() => null);
    const page = isRecord(payload) && Array.isArray(payload.values) ? payload.values : [];
    for (const entry of page) {
      if (isRecord(entry) && str(entry.id)) {
        requestTypes.push({ id: str(entry.id), name: str(entry.name) });
      }
    }
    const lastPage = !isRecord(payload) || payload.isLastPage !== false || page.length === 0;
    if (lastPage) break;
    start += page.length;
  }
  return { ok: true, requestTypes };
}

/** What a request type's form says about one of its fields. */
export interface RequestTypeComponents {
  /** False when the form has no such field — then nothing can set one. */
  present: boolean;
  options: ComponentOption[];
}

/**
 * The request type's whole form, one fetch — the authoritative list of the
 * fields a create can carry. Callers that need several fields (components
 * AND priority, say) extract each with `fieldOptionsOf` instead of paying
 * one fetch per field.
 */
export async function loadRequestTypeForm(
  auth: JsmAuth,
  deskId: string,
  requestTypeId: string
): Promise<{ ok: true; fields: unknown[] } | { ok: false; message: string }> {
  const response = await auth.fetch(
    serviceDeskScopes('jsm_get_request_type_fields', true),
    `/rest/servicedeskapi/servicedesk/${encodeURIComponent(deskId)}` +
      `/requesttype/${encodeURIComponent(requestTypeId)}/field`
  );
  if (!response.ok) return { ok: false, message: await describeJsmAuthFailure(response) };

  const payload: unknown = await response.json().catch(() => null);
  // requestTypeFields is the real key; `.values` belongs to the paged
  // endpoints and reading only that is how this once reported "0 fields".
  const fields =
    isRecord(payload) && Array.isArray(payload.requestTypeFields)
      ? payload.requestTypeFields
      : isRecord(payload) && Array.isArray(payload.values)
        ? payload.values
        : [];
  return { ok: true, fields };
}

/**
 * One field's presence and options, off an already-loaded form.
 *
 * `validValues` entries are `{value, label}` — the id and the name. An empty
 * options list with `present: true` is a real state and not an error: the
 * form has the field, the project just offers no values for it yet.
 */
export function fieldOptionsOf(fields: readonly unknown[], fieldId: string): RequestTypeComponents {
  const field = fields.find((entry: unknown) => isRecord(entry) && str(entry.fieldId) === fieldId);
  if (!field || !isRecord(field)) return { present: false, options: [] };

  const valid = Array.isArray(field.validValues) ? field.validValues : [];
  const options = valid
    .map((entry: unknown) =>
      isRecord(entry) && str(entry.value) ? { id: str(entry.value), name: str(entry.label) } : null
    )
    .filter((entry): entry is ComponentOption => entry !== null);

  return { present: true, options };
}

/** The components THIS request type accepts, from its own form metadata. */
export async function loadRequestTypeComponents(
  auth: JsmAuth,
  deskId: string,
  requestTypeId: string
): Promise<{ ok: true; components: RequestTypeComponents } | { ok: false; message: string }> {
  const form = await loadRequestTypeForm(auth, deskId, requestTypeId);
  if (!form.ok) return form;
  return { ok: true, components: fieldOptionsOf(form.fields, 'components') };
}

/** Every component on the desk's project, whether or not a form accepts it. */
export async function loadProjectComponents(
  auth: JsmAuth,
  projectKey: string
): Promise<{ ok: true; options: ComponentOption[] } | { ok: false; message: string }> {
  if (!projectKey) {
    return { ok: false, message: 'That service desk did not report a project key.' };
  }
  const response = await auth.fetch(
    [PROJECT_COMPONENT_READ],
    `/rest/api/3/project/${encodeURIComponent(projectKey)}/components`
  );
  if (!response.ok) return { ok: false, message: await describeJsmAuthFailure(response) };

  const payload: unknown = await response.json().catch(() => null);
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.values)
      ? payload.values
      : [];
  const options = list
    .map((entry: unknown) =>
      isRecord(entry) && str(entry.name) ? { id: str(entry.id), name: str(entry.name) } : null
    )
    .filter((entry): entry is ComponentOption => entry !== null);
  return { ok: true, options };
}

/**
 * Match what the caller asked for against what the form accepts.
 *
 * Case-insensitive, and by id as readily as by name, because "Billing",
 * "billing" and "10042" are all the same component and only one of them is
 * what somebody typed. Resolving to the ID is the point: a name that
 * differs by a space is exactly the near-miss that used to be dropped.
 */
export function matchComponents(
  requested: readonly string[],
  options: readonly ComponentOption[]
): { resolved: ComponentOption[]; missing: string[] } {
  const resolved: ComponentOption[] = [];
  const missing: string[] = [];
  for (const entry of requested) {
    const text = String(entry).trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    const match = options.find(
      (option) => option.name.toLowerCase() === lower || option.id.toLowerCase() === lower
    );
    if (match) resolved.push(match);
    else missing.push(text);
  }
  return { resolved, missing };
}

/** "Billing (10042), Platform (10043)" — the answer to "then what?". */
export function describeComponents(options: readonly ComponentOption[]): string {
  if (options.length === 0) return 'This project has no components.';
  return options.map((option) => `${option.name} (${option.id})`).join(', ');
}
