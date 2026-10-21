/**
 * SOQL safety. Every tool that composes a query from arguments builds it
 * here — string literals escaped, identifiers checked — and the one tool
 * that takes the model's own SOQL (`salesforce_query`) is checked far enough
 * to refuse anything but a single SELECT and to bound it with a LIMIT.
 *
 * The REST query resource only runs SELECTs, so this is not what stops a
 * write; it is what keeps an argument from changing the shape of a query a
 * tool meant to run (a name containing `' OR Name != '`), and what keeps an
 * unbounded query from spending the org's API budget.
 */

/** A SOQL string literal: quoted, with `\`, `'`, `"` and control characters escaped. */
export function soqlString(value: string): string {
  const escaped = value.replace(/[\\'"\n\r\t\f\b]/g, (ch) => {
    switch (ch) {
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      case '\f':
        return '\\f';
      case '\b':
        return '\\b';
      default:
        return `\\${ch}`;
    }
  });
  return `'${escaped}'`;
}

/**
 * A LIKE pattern for "contains": the literal escaped as above, and LIKE's own
 * wildcards (`%`, `_`) escaped too so a name with an underscore matches
 * itself rather than any character.
 */
export function soqlContains(value: string): string {
  // Escape the literal first, then the wildcards — the other order would
  // have the literal escaping double the wildcards' backslashes.
  const inner = soqlString(value)
    .slice(1, -1)
    .replace(/[%_]/g, (ch) => `\\${ch}`);
  return `'%${inner}%'`;
}

/** An object or field API name, or a dotted relationship path (`Account.Owner.Name`). */
export function isSoqlIdentifier(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*){0,5}$/.test(value);
}

export interface CheckedQuery {
  query: string;
  /** True when this function appended the LIMIT. */
  limited: boolean;
}

/**
 * A model-written query, accepted when it is one SELECT; a top-level LIMIT
 * is appended when there is none. Top level means outside parentheses and
 * string literals, so a LIMIT inside a subquery or a quoted 'LIMIT' does not
 * count.
 */
/** Trailing semicolons and whitespace off — a loop, not /;+\s*$/, which backtracks on long runs. */
function withoutTrailingSemicolons(query: string): string {
  let end = query.length;
  while (end > 0 && (query.charAt(end - 1) === ';' || /\s/.test(query.charAt(end - 1)))) end -= 1;
  return query.slice(0, end);
}

export function checkSelectQuery(
  input: string,
  defaultLimit: number
): { ok: true; value: CheckedQuery } | { ok: false; error: string } {
  const query = withoutTrailingSemicolons(input.trim());
  if (!/^select\s/i.test(query)) {
    return { ok: false, error: 'Only a SOQL SELECT query can be run.' };
  }
  const top = topLevelText(query);
  if (top === null) {
    return { ok: false, error: 'The query has an unterminated string or unbalanced parentheses.' };
  }
  if (top.includes(';')) {
    return { ok: false, error: 'Run one query at a time (no semicolons).' };
  }
  if (/\blimit\s+\d+/i.test(top)) return { ok: true, value: { query, limited: false } };
  return { ok: true, value: { query: `${query} LIMIT ${defaultLimit}`, limited: true } };
}

/**
 * The query with every string literal and parenthesized span replaced by
 * spaces, or null when either does not close.
 */
function topLevelText(query: string): string | null {
  let depth = 0;
  let inString = false;
  let out = '';
  for (let i = 0; i < query.length; i += 1) {
    const ch = query.charAt(i);
    if (inString) {
      if (ch === '\\') {
        i += 1;
      } else if (ch === "'") {
        inString = false;
      }
      out += ' ';
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ' ';
    } else if (ch === '(') {
      depth += 1;
      out += ' ';
    } else if (ch === ')') {
      depth -= 1;
      if (depth < 0) return null;
      out += ' ';
    } else {
      out += depth === 0 ? ch : ' ';
    }
  }
  return inString || depth !== 0 ? null : out;
}
