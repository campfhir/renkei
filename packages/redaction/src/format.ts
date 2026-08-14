/**
 * Site-specific record-number formats, as a pattern language that cannot be
 * turned into a denial of service.
 *
 * WHY NOT REGULAR EXPRESSIONS. This input comes from an org admin and runs
 * inside a shared, multi-tenant Node process, against text of a size the admin
 * does not control. JavaScript's engine backtracks, so `(a+)+$` against a
 * 31-character string takes over a minute of blocked event loop — measured,
 * not theorised. One org's settings row would stall every other org's
 * requests. And there is no safe way to run it anyway: a regex cannot be
 * interrupted once started, so a timeout around it does not work; you would
 * need a separate engine or a worker per call.
 *
 * Static analysis of submitted expressions was the alternative, and it is a
 * heuristic — star-height checks miss cases, and being nearly right is not a
 * security property. So the input is not a regular expression at all.
 *
 * THE LANGUAGE. Every pattern compiles to a fixed sequence of single-character
 * classes with bounded repetition. There is no nesting, no alternation and no
 * unbounded quantifier, so there is nothing to backtrack over: matching is
 * linear in the length of the text, always.
 *
 *   #        one digit
 *   @        one letter
 *   *        one letter or digit
 *   {n}      the previous placeholder, exactly n times
 *   {n,m}    the previous placeholder, n to m times
 *   anything else is a literal character, escaped
 *
 * So `MR-#######` matches MR-4417732, and `@#{6,8}` matches a letter followed
 * by six to eight digits.
 *
 * The letter placeholder is `@` rather than the more obvious `A` because `A`
 * is itself a letter: `PATIENT` would have compiled to "P, any letter, TIENT"
 * and quietly matched more than it said. This covers the record-number shapes real sites use,
 * which is the entire job.
 */

/** Longest a single placeholder may repeat. */
const MAX_REPEAT = 40;
/** Longest a whole pattern may be, in characters of input it can match. */
const MAX_MATCH_LENGTH = 120;
/** Longest pattern source we will even parse. */
export const MAX_FORMAT_SOURCE = 120;

const CLASSES: Record<string, string> = {
  '#': '\\d',
  '@': '[A-Za-z]',
  '*': '[A-Za-z0-9]',
};

/** Escape a literal so it cannot smuggle in regex syntax. */
function literal(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

export interface CompiledFormat {
  regex: RegExp;
  /** The greatest number of characters this pattern can match. */
  maxLength: number;
}

/**
 * Compile one format, or null if it is not usable.
 *
 * Null rather than throw: this is called both when an admin saves (where the
 * answer becomes an error message) and when a tool result is scanned (where a
 * row written by an older version must be skipped, not allowed to break every
 * tool call).
 */
export function compileFormat(source: string): CompiledFormat | null {
  const trimmed = source.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FORMAT_SOURCE) return null;

  let pattern = '';
  let maxLength = 0;
  /** The class most recently emitted, which `{n}` may repeat. */
  let repeatable: string | null = null;

  for (let i = 0; i < trimmed.length; i += 1) {
    const character = trimmed[i];
    if (character === undefined) return null;

    if (character === '{') {
      const close = trimmed.indexOf('}', i);
      if (close === -1 || repeatable === null) return null;
      const spec = trimmed.slice(i + 1, close);
      const match = /^(\d{1,2})(?:,(\d{1,2}))?$/.exec(spec);
      if (!match) return null;
      const min = Number(match[1]);
      const max = match[2] === undefined ? min : Number(match[2]);
      if (min < 1 || max < min || max > MAX_REPEAT) return null;

      // `X{n}` means n of X in total, not one plus n — the class is already
      // in the pattern and the quantifier applies TO it. Emitting n-1 here is
      // what made `*{8}` match eight characters as seven.
      pattern += match[2] === undefined ? `{${min}}` : `{${min},${max}}`;
      // One was already counted for the class itself.
      maxLength += max - 1;
      repeatable = null;
      i = close;
      continue;
    }

    const characterClass = CLASSES[character];
    if (characterClass) {
      pattern += characterClass;
      repeatable = characterClass;
    } else {
      pattern += literal(character);
      repeatable = null;
    }
    maxLength += 1;
    if (maxLength > MAX_MATCH_LENGTH) return null;
  }

  // A pattern of pure literals is a phrase, not a record-number format, and
  // would redact every ordinary mention of that word.
  if (!/[#@*]/.test(trimmed)) return null;
  if (maxLength > MAX_MATCH_LENGTH) return null;

  try {
    // Word boundaries so `MR-####` does not fire inside a longer token.
    return { regex: new RegExp(`\\b${pattern}\\b`, 'g'), maxLength };
  } catch {
    return null;
  }
}

/** Human explanation of why a format was rejected, for the admin form. */
export function describeFormatProblem(source: string): string | null {
  const trimmed = source.trim();
  if (trimmed.length === 0) return 'Empty pattern';
  if (trimmed.length > MAX_FORMAT_SOURCE) {
    return `Longer than ${MAX_FORMAT_SOURCE} characters`;
  }
  if (!/[#@*]/.test(trimmed)) {
    return 'Needs at least one # (digit), @ (letter) or * (letter or digit) — a pattern of plain text would redact that word everywhere';
  }
  if (compileFormat(trimmed) === null) {
    return 'Not a valid pattern. Use # for a digit, @ for a letter, * for either, and {3} or {3,5} to repeat the one before it';
  }
  return null;
}
