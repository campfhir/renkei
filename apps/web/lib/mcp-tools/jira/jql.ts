/**
 * Catching the JQL mistakes a model actually makes, before Jira does.
 *
 * The observed failure, from an agent run:
 *
 *   Jira API 400: Error in the JQL Query: Expecting ')' but got 'ORDER'.
 *   (line 1, character 67)
 *
 * A model had opened a group and written `ORDER BY` while still inside it.
 * Jira's message names a character offset and a token, which is precise and
 * almost useless to a caller holding the query as one long string — so the
 * model retries with the same shape, or gives up and reports failure to the
 * person waiting.
 *
 * What this module does NOT do is repair the query. Inserting the missing
 * `)` immediately before `ORDER BY` is the likely intent, but it is not the
 * only possible one — `a AND (b OR c` could equally have wanted the group to
 * close later — and a search that silently returns results for a DIFFERENT
 * question than the one asked is far worse than a search that fails. The
 * whole point of catching it here is to say something the caller can act on;
 * the caller resubmits.
 *
 * Quote handling is the only subtlety: JQL string literals may contain
 * parentheses, and both `'` and `"` quote them, with backslash escapes. A
 * naive count over the raw text reports `summary ~ "fix (urgent)"` as
 * unbalanced, which would turn this from a help into an obstacle.
 */

export interface JqlProblem {
  /** One sentence naming what is wrong. */
  message: string;
  /** The query as it would need to look, when that is unambiguous. */
  suggestion?: string;
}

interface Scan {
  /** Depth at the end of the string; negative means a `)` with no opener. */
  depth: number;
  /** True if a `)` ever appeared with nothing open. */
  closedTooMany: boolean;
  /** Index of the ORDER BY that sits inside a group, if any. */
  orderByInsideAt: number | null;
  /** Index of the top-level ORDER BY, if any. */
  orderByAt: number | null;
}

/**
 * Walk the query tracking quote state and paren depth.
 *
 * Deliberately not a JQL parser: this recognises exactly the two structural
 * mistakes worth pre-empting and is blind to everything else, so a valid
 * query it does not understand still reaches Jira untouched.
 */
function scan(jql: string): Scan {
  const result: Scan = {
    depth: 0,
    closedTooMany: false,
    orderByInsideAt: null,
    orderByAt: null,
  };
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < jql.length; index += 1) {
    const char = jql[index];

    if (quote) {
      // A backslash escapes the next character, including the closing quote.
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') {
      result.depth += 1;
      continue;
    }
    if (char === ')') {
      if (result.depth === 0) result.closedTooMany = true;
      else result.depth -= 1;
      continue;
    }
    // ORDER BY, case-insensitive, on a word boundary. Only the first one
    // matters: a second is a different error and Jira can own it.
    if ((char === 'o' || char === 'O') && result.orderByAt === null) {
      const ahead = jql.slice(index, index + 8);
      const before = index === 0 ? ' ' : jql[index - 1];
      if (/^order\s+by/i.test(ahead) && /[\s)]/.test(before)) {
        result.orderByAt = index;
        if (result.depth > 0) result.orderByInsideAt = index;
      }
    }
  }

  return result;
}

/**
 * The problem with this query, or null when nothing recognisable is wrong.
 *
 * Null is NOT a claim that the query is valid — only that it does not carry
 * one of the two mistakes this catches. Everything else is still Jira's to
 * judge.
 */
export function checkJql(jql: string): JqlProblem | null {
  const trimmed = jql.trim();
  if (!trimmed) return { message: 'The JQL query is empty.' };

  const result = scan(trimmed);

  if (result.closedTooMany) {
    return {
      message:
        'This JQL has a ")" that closes a group which was never opened. ' +
        'Check the parentheses and send the query again.',
    };
  }

  if (result.depth > 0) {
    const missing = result.depth;
    const plural = missing === 1 ? '' : 's';
    // The ORDER BY case is the one worth spelling out, because it is both the
    // most common and the one whose fix is not obvious from Jira's message.
    if (result.orderByInsideAt !== null) {
      const head = trimmed.slice(0, result.orderByInsideAt).trimEnd();
      const tail = trimmed.slice(result.orderByInsideAt);
      return {
        message:
          `This JQL never closes ${missing} open group${plural}, and its ORDER BY sits inside one. ` +
          'ORDER BY has to come after every parenthesis has been closed, at the very end of the ' +
          'query. Check that the suggested form asks what you meant, then send it again.',
        suggestion: `${head}${')'.repeat(missing)} ${tail}`,
      };
    }
    return {
      message:
        `This JQL never closes ${missing} open group${plural} — count the "(" against the ")". ` +
        'Fix the parentheses and send the query again.',
      suggestion: `${trimmed}${')'.repeat(missing)}`,
    };
  }

  // Balanced overall, but ORDER BY was written inside a group that later
  // closed: `(a OR b ORDER BY x)` parses as nonsense to Jira too.
  if (result.orderByInsideAt !== null) {
    return {
      message:
        'This JQL puts ORDER BY inside parentheses. ORDER BY belongs at the very end of the ' +
        'query, outside every group. Move it there and send the query again.',
    };
  }

  return null;
}

/** The problem as the text a tool returns, suggestion included. */
export function describeJqlProblem(problem: JqlProblem): string {
  return problem.suggestion
    ? `${problem.message}\n\nDid you mean:\n${problem.suggestion}`
    : problem.message;
}

/**
 * The `jql` parameter description, shared by every tool that takes one.
 *
 * States the ORDER BY rule outright: getting it right the first time is
 * cheaper than any error message, however good.
 */
export const JQL_PARAMETER_DESCRIPTION =
  'JQL query, e.g. "project = SCRUM AND status != Done ORDER BY updated DESC". ' +
  'Every "(" must be closed, and ORDER BY goes at the very end, outside all parentheses — ' +
  'write `project = X AND (a OR b) ORDER BY created DESC`, never `(a OR b ORDER BY created)`.';
