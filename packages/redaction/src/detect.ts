/**
 * Finding identifiers in free text.
 *
 * THE GOVERNING CONSTRAINT IS PRECISION, NOT RECALL. This runs over every MCP
 * tool result — Jira issues, mail bodies, Confluence pages, meeting
 * transcripts — and a detector that mangles ordinary data produces a gateway
 * nobody trusts, which gets switched off, which protects nobody. A missed
 * identifier is one failure; a corrupted result set is a failure plus a reason
 * to abandon the whole mechanism.
 *
 * So the detectors here are deliberately narrow:
 *
 *   - Bare dates are never touched. `2026-08-13` appears in every Jira issue
 *     and every mail header; a date is only a date of birth when something
 *     says so.
 *   - Bare numbers are never touched. An MRN has no universal format and is
 *     indistinguishable from an order number, a ticket id, or a build number,
 *     so it is found by its LABEL or by a pattern the org itself supplies.
 *   - Card numbers must pass Luhn AND carry a real issuer prefix. Length alone
 *     matches too many identifiers, and Luhn alone admits one random number in
 *     ten.
 *   - Names are found only next to an explicit patient marker. This gateway is
 *     largely ABOUT names — assignees, senders, attendees, service-desk
 *     customers — and a general name detector would redact the colleagues the
 *     tools exist to talk about. The cost is stated plainly: a patient named
 *     in ordinary prose, with no marker nearby, is not found.
 *
 * Everything here is pure, deterministic, and model-free. Nothing in this file
 * reasons about content; it matches shapes.
 */

import { luhnValid } from './luhn';
import { compileFormat } from './format';

/** Labels are the vocabulary the disclosure policy is written against. */
export const LABEL_SSN = 'phi.ssn';
export const LABEL_CARD = 'pii.payment_card';
export const LABEL_MRN = 'phi.mrn';
export const LABEL_DOB = 'phi.dob';
export const LABEL_PATIENT_NAME = 'phi.patient_name';
export const LABEL_PHONE = 'pii.phone';

/** Detector keys an org switches on and off. */
export type DetectorKey = 'ssn' | 'card' | 'mrn' | 'dob' | 'patient_name' | 'phone';

/**
 * On out of the box: the four with shapes precise enough to run untuned.
 * Patient names and phone numbers are opt-in — names because the marker
 * vocabulary varies by org, phone because a signature block is full of them
 * and redacting those breaks ordinary correspondence.
 */
export const DEFAULT_DETECTORS: readonly DetectorKey[] = ['ssn', 'card', 'mrn', 'dob'];

const ALL_DETECTORS: readonly DetectorKey[] = [
  'ssn',
  'card',
  'mrn',
  'dob',
  'patient_name',
  'phone',
];

/**
 * Keep only the detector names this build knows.
 *
 * Settings are stored as free-form JSON, so the list can contain anything a
 * previous version wrote or an admin typed. Filtering beats asserting: an
 * unknown name silently does nothing, where a cast would smuggle it into a
 * Set and leave the caller believing a detector was running.
 */
export function knownDetectors(values: readonly string[]): DetectorKey[] {
  return ALL_DETECTORS.filter((key) => values.includes(key));
}

export interface Finding {
  /** Index of the first character of the identifier itself. */
  start: number;
  /** Index one past its last character. */
  end: number;
  label: string;
  /** The matched text, used to derive a stable pseudonym. */
  value: string;
}

/**
 * How much a match is trusted when two detectors claim the same characters.
 *
 * Something found behind an explicit label outranks something recognised by
 * shape alone: `MRN: 4111111111111111` is a record number that happens to
 * satisfy Luhn, and reporting it as a payment card would both mislabel it and
 * mask it under the wrong policy rule. Push order decided this until it was
 * tested, which is exactly the kind of accident that only shows up in output.
 */
const LABELLED = 3;
const SHAPED = 2;
const WEAK = 1;

interface Candidate extends Finding {
  priority: number;
}

export interface DetectOptions {
  detectors?: readonly DetectorKey[];
  /**
   * Extra MRN shapes an org knows about, written in the pattern language from
   * `format.ts` — `MR-#######`, not a regular expression. A site whose numbers
   * look like that can say so; there is no way to infer it. Deliberately NOT
   * regex: admin-supplied expressions run in a shared multi-tenant process and
   * can be made to backtrack for minutes (see format.ts). Unparseable entries
   * are skipped rather than thrown, because a bad settings row must not take
   * down every tool call.
   */
  mrnFormats?: readonly string[];
}

/**
 * Text already replaced by this module. Detection skips anything overlapping
 * one, so redacting twice is a no-op rather than a pseudonym of a pseudonym.
 */
const TOKEN = /\[[A-Z_]+(?:-[0-9a-f]{8})?\]/g;

// ---------------------------------------------------------------------------
// Social security numbers
// ---------------------------------------------------------------------------

/**
 * The dashed form only, plus the ranges the SSA never issues (000/666/900+ in
 * the area, 00 in the group, 0000 in the serial). Nine bare digits are NOT
 * matched: too many identifiers are nine digits long, and the dashes are what
 * make this shape distinctive. The labelled form below covers the rest.
 */
const SSN_DASHED = /\b(?!000|666|9\d{2})(\d{3})-(?!00)(\d{2})-(?!0000)(\d{4})\b/g;
const SSN_LABELLED =
  /\b(?:SSN|S\.S\.N\.|social security(?:\s+(?:number|no\.?|#))?)\s*[:#]?\s*(\d{3}-?\d{2}-?\d{4})\b/gi;

// ---------------------------------------------------------------------------
// Payment cards
// ---------------------------------------------------------------------------

/** 13–19 digits, optionally grouped by spaces or hyphens. */
const CARD_CANDIDATE = /\b(?:\d[ -]?){12,18}\d\b/g;

/**
 * Real issuer prefixes. Requiring one alongside Luhn is what separates a card
 * from a long internal identifier that happens to satisfy a checksum.
 */
function hasIssuerPrefix(digits: string): boolean {
  if (/^4/.test(digits))
    return digits.length === 13 || digits.length === 16 || digits.length === 19;
  if (/^(?:5[1-5]|2[2-7])/.test(digits)) return digits.length === 16;
  if (/^3[47]/.test(digits)) return digits.length === 15;
  if (/^(?:6011|65|64[4-9])/.test(digits)) return digits.length === 16 || digits.length === 19;
  if (/^3(?:0[0-5]|[68])/.test(digits)) return digits.length === 14;
  return false;
}

// ---------------------------------------------------------------------------
// Medical record numbers
// ---------------------------------------------------------------------------

/**
 * The value must contain a digit and may be as short as two characters.
 *
 * The digit requirement is what lets the length come down: without it,
 * "MRN is not recorded" captures "is". With it, a three-character record
 * number behind an explicit label is caught — which it was not before, since
 * a four-character minimum quietly skipped `MRN 123`.
 */
const MRN_LABELLED =
  /\b(?:MRN|M\.R\.N\.|medical record(?:\s+(?:number|no\.?|#))?|chart(?:\s+(?:number|no\.?|#))|patient(?:\s+(?:id|identifier|number|no\.?|#)))\s*[:#]?\s*((?=[A-Za-z0-9-]*\d)[A-Za-z0-9][A-Za-z0-9-]{1,19})\b/gi;

// ---------------------------------------------------------------------------
// Dates of birth
// ---------------------------------------------------------------------------

const MONTHS =
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const DATE_FORMS = [
  '\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}',
  '\\d{4}-\\d{2}-\\d{2}',
  `(?:${MONTHS})\\.?\\s+\\d{1,2},?\\s+\\d{4}`,
  `\\d{1,2}\\s+(?:${MONTHS})\\.?\\s+\\d{4}`,
].join('|');
const DOB_LABELLED = new RegExp(
  `\\b(?:DOB|D\\.O\\.B\\.|date of birth|birth\\s?date|born(?:\\s+on)?)\\s*[:#]?\\s*(${DATE_FORMS})`,
  'gi'
);

// ---------------------------------------------------------------------------
// Patient names
// ---------------------------------------------------------------------------

/**
 * Capitalised words that follow "patient" in ordinary product language and are
 * emphatically not names. Without this, "Patient Portal is down" reads as a
 * patient called Portal — the exact false positive that discredits the
 * feature on day one.
 */
const NOT_A_NAME = new Set([
  'portal',
  'access',
  'care',
  'safety',
  'experience',
  'records',
  'record',
  'chart',
  'charts',
  'data',
  'information',
  'satisfaction',
  'population',
  'list',
  'lists',
  'name',
  'names',
  'id',
  'identifier',
  'number',
  'summary',
  'visit',
  'visits',
  'account',
  'accounts',
  'billing',
  'intake',
  'referral',
  'referrals',
  'outcomes',
  'engagement',
  'services',
  'support',
  'advocate',
  'advocacy',
  'relations',
  'flow',
  'volume',
  'census',
  'match',
  'matching',
  'lookup',
  'search',
  'and',
  'or',
  'the',
]);

const TITLE = '(?:Mr|Mrs|Ms|Miss|Dr|Rev)\\.?\\s+';
const NAME_WORD = "[A-Z][A-Za-z'’-]+";
/**
 * The marker is spelled both ways rather than using the `i` flag: the flag
 * would apply to the NAME too, and requiring a capitalised name is most of
 * what keeps "patient records migration" from reading as a person.
 */
const MARKER = '(?:[Pp]atient|[Pp]t\\.?|[Mm]ember|[Cc]lient|[Rr]esident)';
/** A middle initial is a name part: "Jane A Doe" is one person, not one word. */
const INITIAL = '[A-Z]\\.?';
const PATIENT_NAME_LABELLED = new RegExp(
  `\\b${MARKER}\\s*(?:[Nn]ame)?\\s*[:#-]?\\s+((?:${TITLE})?${NAME_WORD}(?:\\s+(?:${NAME_WORD}|${INITIAL})){0,2})`,
  'g'
);

function looksLikeName(candidate: string): boolean {
  const words = candidate.replace(/\b(?:Mr|Mrs|Ms|Miss|Dr|Rev)\.?\s+/g, '').split(/\s+/);
  if (words.length === 0) return false;
  // Every word must be plausible; one product noun disqualifies the phrase.
  return words.every((word) => !NOT_A_NAME.has(word.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Phone numbers (opt-in)
// ---------------------------------------------------------------------------

const PHONE = /\b(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}\b(?!\d)/g;

// ---------------------------------------------------------------------------

function pushMatches(
  found: Candidate[],
  text: string,
  pattern: RegExp,
  label: string,
  group: number,
  priority: number
): void {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const value = match[group];
    if (value === undefined) continue;
    // The identifier's own offset, not the label's: "MRN: 4417732" replaces
    // the number and leaves the word MRN, which is what makes the result
    // still readable.
    const start = match.index + match[0].lastIndexOf(value);
    found.push({ start, end: start + value.length, label, value, priority });
  }
}

function detectCards(found: Candidate[], text: string): void {
  CARD_CANDIDATE.lastIndex = 0;
  for (let match = CARD_CANDIDATE.exec(text); match !== null; match = CARD_CANDIDATE.exec(text)) {
    const raw = match[0];
    const digits = raw.replace(/[ -]/g, '');
    if (!hasIssuerPrefix(digits) || !luhnValid(digits)) continue;
    found.push({
      start: match.index,
      end: match.index + raw.length,
      label: LABEL_CARD,
      value: raw,
      priority: SHAPED,
    });
  }
}

function detectCustomMrn(found: Candidate[], text: string, formats: readonly string[]): void {
  for (const source of formats) {
    const compiled = compileFormat(source);
    // A malformed entry is skipped. Refusing the whole result over a bad
    // settings row would turn a typo into an outage.
    if (!compiled) continue;
    pushMatches(found, text, compiled.regex, LABEL_MRN, 0, LABELLED);
  }
}

/** Spans covered by an already-substituted token, which must not be re-read. */
function tokenSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(text); match !== null; match = TOKEN.exec(text)) {
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/**
 * Every identifier in `text`, ordered by position and non-overlapping.
 *
 * Where two detectors claim overlapping text the longer match wins, and ties
 * go to the first found: a labelled MRN that happens to satisfy Luhn should
 * read as an MRN, not as a payment card.
 */
export function detect(text: string, options: DetectOptions = {}): Finding[] {
  if (!text) return [];
  const enabled = new Set(options.detectors ?? DEFAULT_DETECTORS);
  const found: Candidate[] = [];

  if (enabled.has('ssn')) {
    pushMatches(found, text, SSN_DASHED, LABEL_SSN, 0, SHAPED);
    pushMatches(found, text, SSN_LABELLED, LABEL_SSN, 1, LABELLED);
  }
  if (enabled.has('card')) detectCards(found, text);
  if (enabled.has('mrn')) {
    pushMatches(found, text, MRN_LABELLED, LABEL_MRN, 1, LABELLED);
    detectCustomMrn(found, text, options.mrnFormats ?? []);
  }
  if (enabled.has('dob')) pushMatches(found, text, DOB_LABELLED, LABEL_DOB, 1, LABELLED);
  if (enabled.has('patient_name')) {
    const named: Candidate[] = [];
    pushMatches(named, text, PATIENT_NAME_LABELLED, LABEL_PATIENT_NAME, 1, LABELLED);
    for (const finding of named) {
      if (looksLikeName(finding.value)) found.push(finding);
    }
  }
  if (enabled.has('phone')) pushMatches(found, text, PHONE, LABEL_PHONE, 0, WEAK);

  const tokens = tokenSpans(text);
  const candidates = found
    .filter((finding) => !tokens.some((t) => finding.start < t.end && finding.end > t.start))
    .sort((a, b) => a.start - b.start || b.priority - a.priority || b.end - a.end);

  const kept: Finding[] = [];
  let lastEnd = -1;
  for (const candidate of candidates) {
    if (candidate.start < lastEnd) continue;
    kept.push({
      start: candidate.start,
      end: candidate.end,
      label: candidate.label,
      value: candidate.value,
    });
    lastEnd = candidate.end;
  }
  return kept;
}
