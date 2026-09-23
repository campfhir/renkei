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
