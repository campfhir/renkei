/**
 * A Jira issue, flattened into the document that gets embedded.
 *
 * What it used to produce was `KEY: summary` plus a status line. The
 * description was meant to be in there — the old function said so — but REST
 * v3 returns descriptions as ADF node trees, and running a string coercion
 * over an object yields an empty string, so every issue in the index carried
 * its title twice and nothing else. Searching for anything said in a
 * description could not work, and the knowledge page showed a heading above a
 * copy of that heading.
 *
 * The shape below is one heading, then prose, then facts, then discussion:
 *
 *   # <summary>
 *   ## Description      the ADF description as markdown
 *   ## Fields           display name: value, one per line
 *   ## Comments         author, date, body
 *
 * Field names come from Jira's own `names` expansion rather than a hardcoded
 * list. That matters most for the fields nobody can predict: "Request
 * participants" is a custom field whose id differs per site, so a fixed list
 * would either miss it or need per-site configuration. Asking Jira what its
 * fields are called gets it, and every other custom field, for free.
 */

import {
  adfToMarkdown,
  demoteHeadings,
  listOf,
  rec,
  str,
  wikiToMarkdown,
} from '@renkei/connector-atlassian';

/** Fields that are noise in a document: internal ids, avatars, and the ones
 * already rendered as headings or metadata. */
const SKIP_FIELDS = new Set([
  'summary',
  'description',
  'comment',
  'attachment',
  'subtasks',
  'issuelinks',
  'worklog',
  'thumbnail',
  'lastViewed',
  'workratio',
  'watches',
  'votes',
  'progress',
  'aggregateprogress',
  'statuscategorychangedate',
  'issuerestriction',
  'security',
  // Duplicates `status`, one level less specific.
  'statusCategory',
  // Time accounting in raw seconds. `timetracking` carries the same numbers
  // in the form a person reads ("45m logged"), and IS indexed; a bare
  // `Timespent: 2700` beside it helps nobody.
  'timespent',
  'timeestimate',
  'timeoriginalestimate',
  'aggregatetimespent',
  'aggregatetimeestimate',
  'aggregatetimeoriginalestimate',
]);

/**
 * Values that are machine plumbing wearing a string.
 *
 * A real instance returns a board rank as `1|i1dxy7:`, a workflow property as
 * `10010_*:*_1_*:*_0_*|*_10126_*:*_1_*:*_21949782`, and an empty config as
 * `{}`. All arrive under custom-field ids with perfectly ordinary display
 * names, so nothing upstream marks them as noise — but embedding them adds
 * tokens no one will ever search for, and printing them makes the fields
 * section unreadable.
 */
function looksInternal(text: string): boolean {
  if (text === '{}' || text === '[]') return true;
  // Lexorank. The trailing segment is optional and often present —
  // `1|i1dxy7:` and `1|i1g0gc:zr` are both ranks, and anchoring at the colon
  // let the second form through on a live board.
  if (/^\d+\|[a-z0-9]+:[a-z0-9]*$/i.test(text)) return true;
  // Atlassian's `_*:*_` delimited property blobs.
  if (text.includes('_*:*_')) return true;
  return false;
}

/**
 * A rich-text field's text, whichever form it arrives in.
 *
 * REST v3 returns ADF node trees; v2 — and some Cloud responses on instances
 * still speaking it — returns a plain string. Running the ADF converter over a
 * string yields nothing, which is the same silent drop that hid descriptions
 * in the first place, just by a different route. Handling both is two lines
 * and removes a whole class of "why is this empty".
 */
function richText(value: unknown): string {
  // A string is wiki markup, not markdown — a different language that shares
  // `#` and disagrees about what it means (see wikiToMarkdown).
  if (typeof value === 'string') return wikiToMarkdown(value);
  return adfToMarkdown(value).trim();
}

/** Per-field ceiling for a one-line value. */
const MAX_FIELD_CHARS = 500;
/** Per-field ceiling for a rich-text field, which is prose and earns more room. */
const MAX_BLOCK_FIELD_CHARS = 4_000;
/** Comments kept, newest last — a long-running ticket should not dominate. */
const MAX_COMMENTS = 20;
/** Per-comment ceiling. */
const MAX_COMMENT_CHARS = 1_500;
/** Whole-document ceiling, before chunking. */
const MAX_DOCUMENT_CHARS = 40_000;

/**
 * How far to push an author's own headings down, per place they can appear.
 *
 * ADF authors write headings, and a description opening `# Overview` would
 * outrank the `## Description` it sits under, while a comment containing
 * `## Fields` would be indistinguishable from the issue's real field list.
 * Each shift puts the embedded headings strictly below their container: a
 * description lives under a level-2 heading, a rich-text field and a comment
 * each under a level-3 one.
 */
const DEMOTE_IN_DESCRIPTION = 2;
const DEMOTE_IN_FIELD = 3;
const DEMOTE_IN_COMMENT = 3;

/**
 * A rendered field value.
 *
 * `block` marks prose — a rich-text custom field, or anything that came back
 * with line breaks in it. Those cannot go in a `Label: value` list without
 * destroying both the value and the list, so they get their own subsection.
 */
interface RenderedValue {
  text: string;
  block: boolean;
}

/**
 * One field value as text, or null when there is nothing worth saying.
 *
 * Jira returns the same idea in many shapes — a bare string, `{name}` for a
 * status, `{displayName}` for a user, `{value}` for a select option, and
 * arrays of any of those — so this reduces them all to the words a person
 * would read.
 */
function renderValue(value: unknown): RenderedValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    // `2026-08-11T08:00:00.000+0000` is a fact about a database, not about the
    // ticket. The day is what anyone reads or searches for.
    if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return { text: text.slice(0, 10), block: false };
    // A multi-line string field is wiki markup — a backout plan, a test plan.
    // Converted so its numbered steps stay steps instead of becoming headings.
    if (text.includes('\n')) return { text: wikiToMarkdown(text), block: true };
    return { text, block: false };
  }
  if (typeof value === 'number') return { text: String(value), block: false };
  if (typeof value === 'boolean') return { text: value ? 'yes' : 'no', block: false };

  if (Array.isArray(value)) {
    const parts = value.map(renderValue).filter((part): part is RenderedValue => part !== null);
    if (parts.length === 0) return null;
    // A list of prose stays prose; a list of names is one comma-joined line.
    const block = parts.some((part) => part.block);
    return { text: parts.map((part) => part.text).join(block ? '\n\n' : ', '), block };
  }

  if (typeof value === 'object') {
    const record = rec(value);
    // Time tracking carries both a readable form and a seconds form; the
    // seconds are skipped elsewhere and this is the half worth indexing.
    const logged = str(record.timeSpent);
    const remaining = str(record.remainingEstimate);
    if (logged || remaining) {
      const parts = [logged ? `${logged} logged` : '', remaining ? `${remaining} remaining` : ''];
      return { text: parts.filter(Boolean).join(', '), block: false };
    }
    // A rich-text custom field. Jira lets you have those, and they hold real
    // prose — acceptance criteria, steps to reproduce — so they are worth
    // rendering properly rather than skipping.
    if (str(record.type) === 'doc') {
      // Demoted by the caller, which is the only place that knows what
      // heading this value will end up underneath.
      const text = adfToMarkdown(record).trim();
      return text ? { text, block: true } : null;
    }
    // The usual wrappers, in the order Jira favours them.
    for (const key of ['displayName', 'name', 'value', 'emailAddress', 'key']) {
      const inner = record[key];
      if (typeof inner === 'string' && inner.trim()) {
        return { text: inner.trim(), block: false };
      }
    }
    return null;
  }

  return null;
}

/**
 * A readable label for a field id, used only when Jira's `names` map is
 * missing one. Production always sends the map, so this is the seatbelt: a
 * field labelled `fixVersions` reads worse than `Fix versions`, and either
 * beats dropping the field because it had no name.
 */
/**
 * Jira prefixes some field names with a bracketed marker — `[CHART] Date of
 * First Response` — to say where the field is usable. It is a note to an
 * administrator, not part of the name, and it reads as noise in a document.
 */
function cleanLabel(label: string): string {
  return label.replace(/^\[[A-Z]+\]\s*/, '').trim() || label;
}

function humanizeFieldId(id: string): string {
  const spaced = id
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : id;
}

/**
 * Every account id → display name pair anywhere in the issue.
 *
 * Comments mention people as `[~accountid:5b21a397…]`, which embeds an opaque
 * identifier where a name belongs: unsearchable, unreadable, and pure token
 * cost. The names are already in the payload — the same people are the
 * assignee, the reporter, a comment author — so the issue can resolve its own
 * mentions with no extra call.
 */
function accountNames(value: unknown, into: Map<string, string> = new Map()): Map<string, string> {
  if (Array.isArray(value)) {
    for (const item of value) accountNames(item, into);
    return into;
  }
  if (typeof value !== 'object' || value === null) return into;
  const record = rec(value);
  const id = str(record.accountId);
  const name = str(record.displayName);
  if (id && name) into.set(id, name);
  for (const child of Object.values(record)) accountNames(child, into);
  return into;
}

const MENTION = /\[~(?:accountid:)?([^\]]+)\]/g;

/** Swap `[~accountid:…]` for the person's name, or for nothing useful lost. */
function resolveMentions(text: string, names: Map<string, string>): string {
  return text.replace(MENTION, (whole, id: string) => {
    const name = names.get(id.trim());
    // An id we cannot resolve becomes a neutral marker rather than staying a
    // 24-character hex string nobody can read or search.
    return name ? `@${name}` : '@someone';
  });
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** `2026-08-14T09:12:00.000+0000` → `2026-08-14`. */
function shortDate(value: unknown): string {
  const raw = str(value);
  return raw.length >= 10 ? raw.slice(0, 10) : raw;
}

function renderComments(fields: Record<string, unknown>, names: Map<string, string>): string[] {
  const container = rec(fields.comment);
  const comments = listOf(container, 'comments');
  if (comments.length === 0) return [];

  // Newest are the ones that matter; keep the tail and say so if trimmed.
  const kept = comments.slice(-MAX_COMMENTS);
  const lines: string[] = ['## Comments', ''];
  if (comments.length > kept.length) {
    lines.push(`_${comments.length - kept.length} earlier comments not included._`, '');
  }
  for (const comment of kept) {
    const author = str(rec(comment.author).displayName) || 'Unknown';
    const when = shortDate(comment.created);
    const body = truncate(
      resolveMentions(demoteHeadings(richText(comment.body), DEMOTE_IN_COMMENT), names),
      MAX_COMMENT_CHARS
    );
    if (!body) continue;
    lines.push(`### ${author}${when ? ` — ${when}` : ''}`, '', body, '');
  }
  // Only a heading and no bodies is not a comments section.
  return lines.length > 2 ? lines : [];
}

/**
 * Build the document for one issue.
 *
 * `names` is Jira's field-id → display-name map, from `expand: ['names']`.
 * Without it the fields section would read `customfield_10101: Alice`, which
 * is not a fact anyone can use.
 */
export function jiraDocument(
  issue: Record<string, unknown>,
  names: Record<string, unknown> = {},
  /**
   * Custom-field ids that belong on this issue's screen, from the project and
   * issue type's edit metadata. Undefined means "no metadata available" and
   * every field with a value is kept — losing content quietly is worse than
   * carrying a little noise.
   *
   * Only CUSTOM fields are filtered. Edit metadata describes what can be
   * edited, so it has no status, resolution, created, updated or time
   * tracking; filtering system fields against it would delete the spine of
   * the document.
   */
  allowedCustomFields?: ReadonlySet<string>
): string {
  const fields = rec(issue.fields);
  const key = str(issue.key);
  const summary = str(fields.summary);

  const sections: string[] = [`# ${summary || key}`, ''];

  const mentions = accountNames(issue);
  const description = resolveMentions(
    demoteHeadings(richText(fields.description), DEMOTE_IN_DESCRIPTION),
    mentions
  );
  if (description) {
    sections.push('## Description', '', description, '');
  }

  const fieldLines: string[] = [];
  const blockFields: { label: string; text: string }[] = [];
  // `Key` first: it is the handle a person actually uses, and it is not a
  // field Jira returns inside `fields`.
  if (key) fieldLines.push(`Key: ${key}`);
  for (const [id, value] of Object.entries(fields)) {
    if (SKIP_FIELDS.has(id)) continue;
    // A custom field carrying a value it should not have is the common case
    // on a project that was reconfigured: the value lingers, the field is off
    // the screen, and indexing it puts words in the issue's mouth.
    if (allowedCustomFields && id.startsWith('customfield_') && !allowedCustomFields.has(id)) {
      continue;
    }
    const rendered = renderValue(value);
    if (!rendered || looksInternal(rendered.text)) continue;
    const label = cleanLabel(str(names[id]) || humanizeFieldId(id));
    // An SLA field renders as its own name — "Issue Resolution: Issue
    // Resolution" — because the useful part is a cycle object this does not
    // read. A line that only restates its label carries nothing.
    if (rendered.text.trim().toLowerCase() === label.toLowerCase()) continue;
    if (rendered.block) {
      blockFields.push({
        label,
        text: truncate(demoteHeadings(rendered.text, DEMOTE_IN_FIELD), MAX_BLOCK_FIELD_CHARS),
      });
    } else {
      fieldLines.push(`${label}: ${truncate(rendered.text, MAX_FIELD_CHARS)}`);
    }
  }
  if (fieldLines.length > 0 || blockFields.length > 0) {
    sections.push('## Fields', '');
    // Sorted so the same issue produces the same document across syncs —
    // object key order is stable in practice but not a promise, and a
    // reordered document is a needless re-embed. `Key` stays pinned first.
    const [first, ...rest] = fieldLines;
    if (first) sections.push(first);
    sections.push(...rest.sort((a, b) => a.localeCompare(b)), '');
    // Prose fields after the one-liners, each under its own heading so the
    // list above stays scannable and the prose keeps its line breaks.
    for (const field of blockFields.sort((a, b) => a.label.localeCompare(b.label))) {
      sections.push(`### ${field.label}`, '', field.text, '');
    }
  }

  sections.push(...renderComments(fields, mentions));

  return truncate(sections.join('\n').trim(), MAX_DOCUMENT_CHARS);
}
