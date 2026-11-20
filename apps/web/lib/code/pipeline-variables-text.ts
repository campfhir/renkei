/**
 * A pipeline variable set as the text box shows it — the client-safe
 * half of lib/code/bitbucket-pipelines.ts's "variables as text": plain
 * ones as `KEY=value` (a value quoted the way a `.env` needs it),
 * secured ones as `secret KEY=` since their value cannot be read back.
 * Nothing here touches the server; the page imports it directly.
 */

export interface RenderableVariable {
  key: string;
  /** Null for a secured variable. */
  value: string | null;
  secured: boolean;
}

/** A value as a `.env` line's right-hand side: bare when it can be, double-quoted otherwise. */
function renderValue(value: string): string {
  if (value === '') return '';
  if (/^[^\s"'#\\]+$/.test(value)) return value;
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

/** The set as text, for the box: plain ones with their values, secured ones as `secret KEY=`. */
export function renderVariableText(variables: readonly RenderableVariable[]): string {
  return variables
    .map((variable) =>
      variable.secured
        ? `secret ${variable.key}=`
        : `${variable.key}=${renderValue(variable.value ?? '')}`
    )
    .join('\n');
}

/** Where the cursor goes in the box: a range, empty when start equals end. */
export interface Caret {
  start: number;
  end: number;
}

function escapeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_]/g, '');
}

/**
 * The box's text made ready to type one variable's value, and where the
 * cursor goes. A key that has a line already keeps it: the cursor goes
 * just past its `=`, the value it has selected so typing replaces it. A
 * key with no line gets one at the end — `KEY=`, or `secret KEY=` for a
 * secret — with the cursor after the `=`.
 */
export function withVariableLine(
  text: string,
  key: string,
  secured: boolean
): { text: string; caret: Caret } {
  const line = new RegExp(
    `^[ \\t]*(?:(?:secret|secured)[ \\t]+)?(?:export[ \\t]+)?${escapeKey(key)}[ \\t]*[=:]`,
    'im'
  ).exec(text);
  if (line) {
    const start = line.index + line[0].length;
    const lineEnd = text.indexOf('\n', start);
    const end = lineEnd === -1 ? text.length : lineEnd;
    return { text, caret: { start, end: text[end - 1] === '\r' ? end - 1 : end } };
  }
  const base = text.replace(/\s+$/, '');
  const next = `${base}${base ? '\n' : ''}${secured ? 'secret ' : ''}${key}=`;
  return { text: next, caret: { start: next.length, end: next.length } };
}
