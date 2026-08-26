/**
 * Deterministic filters on an event trigger — the conditions checked BEFORE
 * a run row exists, so a filtered-out event costs one string comparison
 * rather than a run and a model call.
 *
 * This is Decision #16 ("gates are deterministic code, never LLM-inferred")
 * applied one layer earlier: not "what may the agent reach" but "should the
 * agent wake at all". No prompt, no model, no judgement — a person says
 * "only this space" and only that space is what fires.
 *
 * The module is deliberately CATALOG-FREE. Every function takes the field
 * list it should work against, so `trigger-catalog.ts` can import these
 * types without this file importing the catalog back. The catalog owns the
 * event-id-shaped wrappers (`matchesTriggerEvent`, `triggerFilterFields`);
 * everything here is pure and client-safe, which is what lets the builder
 * render a filter and the worker evaluate it from one definition.
 *
 * ## The semantics, decided here so they are not decided by accident
 *
 * - **Within a field, OR. Between fields, AND.** Three sender addresses mean
 *   "from any of these three"; a sender list plus a subject filter means
 *   both must hold.
 * - **Empty or absent means no constraint** — never "match nothing". An
 *   agent that silently stops firing is the worse failure, and an empty list
 *   is what a half-finished edit looks like.
 * - **A constraint set against a payload key that is missing FAILS CLOSED.**
 *   "Only from these senders" is not satisfied by an event carrying no
 *   sender. This is the one place the rule above inverts, and it is
 *   deliberate: the constraint was stated, so it must hold.
 * - **An unknown field id in a stored match is IGNORED**, and its siblings
 *   still apply. That is the rollback case — deploy N-1 reading a filter
 *   that deploy N wrote — where silencing the agent would be worse than
 *   honouring one filter fewer.
 */

/** How the builder renders a field. */
export type FilterInputKind = 'text' | 'text-list' | 'picker-list';

/**
 * How the runtime compares. A new connector adds catalog entries; only a
 * genuinely new comparison semantic needs a new member here, which is what
 * keeps "extensible per connector" from meaning "a switch that grows".
 */
export type FilterMatchKind =
  /** Case-insensitive substring of the payload string. */
  | 'contains'
  /** Case-insensitive exact match against any entry. */
  | 'equals-any'
  /** The payload address ends with '@' + the value, case-insensitively. */
  | 'address-domain'
  /**
   * Exact, case-SENSITIVE match against any entry. For opaque provider
   * identifiers — a WebEx room id is base64 of a URN, and lowercasing one
   * yields a filter that silently never matches.
   */
  | 'id-equals-any';

/** Where a picker's options come from, or a list's non-exclusive hints. */
export type FilterOptionSource = 'webex-rooms' | 'microsoft-people';

export interface TriggerFilterField {
  /**
   * The stable key inside the stored `match`. Renaming one silently drops
   * that filter from every saved trigger, so treat these as permanent.
   */
  id: string;
  /**
   * The payload key to compare — a catalog `provides` name with the
   * `trigger.` prefix removed, because the fan-out payload is exactly what
   * those descriptors promise.
   */
  payloadKey: string;
  match: FilterMatchKind;
  input: FilterInputKind;
  label: string;
  hint: string;
  placeholder?: string;
  /** List inputs only; entries past this are dropped at normalize time. */
  maxEntries?: number;
  /** Scalar inputs only. */
  maxLength?: number;
  /** Per-entry shape gate. Repo-authored only — never a user-supplied regex. */
  pattern?: RegExp;
  /** What to say when `pattern` rejects an entry. */
  invalidMessage: string;
  /** Required for 'picker-list': the option list IS the input. */
  picker?: FilterOptionSource;
  /**
   * A NON-EXCLUSIVE typeahead for a 'text-list'. Suggestions help; a typed
   * value is always accepted, because a directory never has every address
   * a person might want to filter on.
   */
  suggest?: FilterOptionSource;
  /**
   * Plain-English fragment for one value, e.g. 'from {value}'. `{value}` is
   * substituted. A field over opaque ids simply omits the placeholder, so
   * a room id is never shown to somebody who chose a space by name.
   */
  describeOne: string;
  /** Fragment for more than one, e.g. 'from any of {count} senders'. */
  describeMany?: string;
}

/** Scalars for `text`, arrays for the list inputs. */
export type TriggerMatchValue = string | string[];
export type TriggerMatch = Record<string, TriggerMatchValue>;

/**
 * The ceiling on any one list. An unbounded list is a config that can slow
 * the fan-out path for every inbound event of that type, and nobody
 * legitimately filters on more spaces than this.
 */
export const MAX_FILTER_ENTRIES = 25;

/** Matchers that compare human-entered text, so case must not matter. */
const CASE_FOLDING: ReadonlySet<FilterMatchKind> = new Set<FilterMatchKind>([
  'contains',
  'equals-any',
  'address-domain',
]);

const LIST_INPUTS: ReadonlySet<FilterInputKind> = new Set<FilterInputKind>([
  'text-list',
  'picker-list',
]);

function isListField(field: TriggerFilterField): boolean {
  return LIST_INPUTS.has(field.input);
}

/** Trim, and fold case only where the matcher compares human text. */
function foldEntry(field: TriggerFilterField, raw: string): string {
  const trimmed = raw.trim();
  return CASE_FOLDING.has(field.match) ? trimmed.toLowerCase() : trimmed;
}

/**
 * The wire shape gate. Deliberately structural rather than field-aware:
 * this runs on a payload before we know which event it belongs to, and its
 * job is only to refuse something that is not a filter at all. Field-level
 * rules live in `validateMatch`, where the messages can be useful.
 */
export function isTriggerMatch(value: unknown): value is TriggerMatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) =>
      typeof entry === 'string' ||
      (Array.isArray(entry) && entry.every((item) => typeof item === 'string'))
  );
}

/**
 * The canonical form of a stored match: the shape the matcher assumes and
 * the shape the database holds. Run on BOTH the write and the read path —
 * jsonb strips types on the way out, and a row hand-edited or written by an
 * older deploy must not be able to throw the fan-out.
 *
 * Unknown keys are dropped rather than kept. Keeping them would let a
 * typo'd filter sit in the row looking effective while matching nothing.
 */
export function normalizeMatch(fields: TriggerFilterField[], raw: unknown): TriggerMatch {
  if (!isTriggerMatch(raw)) return {};
  const out: TriggerMatch = {};
  for (const field of fields) {
    const value = raw[field.id];
    if (value === undefined) continue;
    if (isListField(field)) {
      const entries = Array.isArray(value) ? value : [value];
      const cleaned = [...new Set(entries.map((entry) => foldEntry(field, entry)).filter(Boolean))];
      if (cleaned.length > 0) {
        out[field.id] = cleaned.slice(0, field.maxEntries ?? MAX_FILTER_ENTRIES);
      }
      continue;
    }
    // A scalar field handed a list takes the first usable entry rather than
    // failing: the alternative is dropping a filter the user can see.
    const scalar = Array.isArray(value) ? (value[0] ?? '') : value;
    const cleaned = foldEntry(field, scalar);
    if (cleaned) out[field.id] = cleaned;
  }
  return out;
}

/**
 * Field-level problems, as sentences. Empty array means usable — including
 * for an empty match, which is the ordinary "no filters" case.
 */
export function validateMatch(fields: TriggerFilterField[], raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!isTriggerMatch(raw)) return ['The trigger filters are not in a usable shape.'];
  const problems: string[] = [];
  const known = new Map(fields.map((field) => [field.id, field]));
  for (const [id, value] of Object.entries(raw)) {
    const field = known.get(id);
    // Silently tolerated rather than reported: an unknown id is the
    // rollback case, and it is already ignored by the matcher.
    if (!field) continue;
    if (isListField(field)) {
      const entries = Array.isArray(value) ? value : [value];
      const cap = field.maxEntries ?? MAX_FILTER_ENTRIES;
      if (entries.length > cap) {
        problems.push(`${field.label} takes at most ${cap} entries.`);
      }
      for (const entry of entries) {
        const cleaned = foldEntry(field, entry);
        if (cleaned && field.pattern && !field.pattern.test(cleaned)) {
          problems.push(`${field.invalidMessage} ("${entry}")`);
        }
      }
      continue;
    }
    const cleaned = foldEntry(field, Array.isArray(value) ? (value[0] ?? '') : value);
    if (!cleaned) continue;
    if (field.maxLength && cleaned.length > field.maxLength) {
      problems.push(`${field.label} must be ${field.maxLength} characters or fewer.`);
    }
    if (field.pattern && !field.pattern.test(cleaned)) {
      problems.push(field.invalidMessage);
    }
  }
  return problems;
}

/** The entries a field constrains on, or [] when it constrains nothing. */
function constraintOf(field: TriggerFilterField, match: TriggerMatch): string[] {
  const value = match[field.id];
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry) => foldEntry(field, entry)).filter(Boolean);
}

function satisfies(field: TriggerFilterField, entries: string[], subject: string): boolean {
  switch (field.match) {
    case 'contains': {
      const haystack = subject.toLowerCase();
      return entries.some((entry) => haystack.includes(entry));
    }
    case 'equals-any': {
      const actual = subject.trim().toLowerCase();
      return entries.includes(actual);
    }
    case 'address-domain': {
      const actual = subject.toLowerCase();
      return entries.some((entry) => actual.endsWith(`@${entry}`));
    }
    case 'id-equals-any': {
      // No folding: these are opaque provider identifiers.
      return entries.includes(subject.trim());
    }
  }
}

/**
 * Does this event satisfy every constrained field?
 *
 * Fields the match does not constrain are skipped. A constrained field
 * whose payload key is missing or non-string fails — see the fail-closed
 * note at the top of this file.
 */
export function matchesFilters(
  fields: TriggerFilterField[],
  match: unknown,
  payload: Record<string, unknown>
): boolean {
  if (!isTriggerMatch(match)) return true;
  for (const field of fields) {
    const entries = constraintOf(field, match);
    if (entries.length === 0) continue;
    const subject = payload[field.payloadKey];
    if (typeof subject !== 'string' || subject === '') return false;
    if (!satisfies(field, entries, subject)) return false;
  }
  return true;
}

/**
 * The filter as a sentence — "from any of 3 senders, and the subject
 * contains "invoice"".
 *
 * One implementation, used by the builder panel, the canvas node summary
 * and the drafting prompt, so those three can never describe the same
 * filter differently. Returns null when nothing is constrained, letting
 * each caller word "no filters" to suit its surface.
 */
export function describeFilters(fields: TriggerFilterField[], match: unknown): string | null {
  if (!isTriggerMatch(match)) return null;
  const parts: string[] = [];
  for (const field of fields) {
    const entries = constraintOf(field, match);
    if (entries.length === 0) continue;
    const template =
      entries.length === 1 || !field.describeMany ? field.describeOne : field.describeMany;
    parts.push(
      template.replace('{value}', entries[0] ?? '').replace('{count}', String(entries.length))
    );
  }
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0] ?? null;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** True when nothing is constrained — the "runs on every event" case. */
export function isEmptyMatch(fields: TriggerFilterField[], match: unknown): boolean {
  if (!isTriggerMatch(match)) return true;
  return fields.every((field) => constraintOf(field, match).length === 0);
}

/* ------------------------------------------------------------------ */
/* Shared field shapes                                                 */
/* ------------------------------------------------------------------ */

/**
 * Loose on purpose. This gate exists to catch a typo'd address, not to
 * adjudicate RFC 5322 — a rejected address a provider would have accepted
 * is a filter the user cannot express.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The domain check that shipped with the original `fromDomain`, unchanged. */
export const DOMAIN_PATTERN = /^[A-Za-z0-9.-]{1,255}$/;
