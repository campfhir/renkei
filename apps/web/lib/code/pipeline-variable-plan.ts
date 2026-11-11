/**
 * What a chat may do to a project's pipeline variables, decided before
 * the host is asked (pipeline-tools.ts makes the calls): which of the
 * names it sent are written, which are removed, and which are left alone
 * and why. Pure, and tested in pipeline-variable-plan.test.ts.
 *
 * A chat reads and sets the plain variables a drafted pipeline needs — an
 * API base URL, a region, a deploy target. It never touches a secured one
 * (it could not see its value, and replacing or deleting one cannot be
 * undone), and it does not write a value for a name that reads as a
 * secret: a token typed into a tool call is a token in a transcript. The
 * person sets those on the Pipelines page, where a value goes to the host
 * once and is never shown again.
 */

export interface PlannedVariable {
  key: string;
  secured: boolean;
}

export interface VariableWriteInput {
  /** Names to values: created, or changed when the value differs. */
  variables: Record<string, string>;
  /** Names to take away. */
  remove: string[];
}

export interface VariableWritePlan {
  set: Array<{ key: string; value: string }>;
  remove: string[];
  /** Names left alone, each with the reason a person can act on. */
  refused: Array<{ key: string; reason: string }>;
}

const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_?KEY|API_?KEY|ACCESS_?KEY|CREDENTIAL)/i;

/** A name that reads as one a secret is kept under. */
export function looksLikeSecret(key: string): boolean {
  return SECRET_NAME.test(key);
}

/**
 * The plan for one write. `validate` is the host's own rule for a name and
 * value (null when fine, else the message); `current` is the set as the
 * host has it, secured ones included by name.
 */
export function planVariableWrite(
  current: readonly PlannedVariable[],
  input: VariableWriteInput,
  validate: (key: string, value: string) => string | null
): VariableWritePlan {
  const existing = new Map(current.map((variable) => [variable.key, variable]));
  const plan: VariableWritePlan = { set: [], remove: [], refused: [] };
  for (const [key, value] of Object.entries(input.variables)) {
    if (existing.get(key)?.secured) {
      plan.refused.push({
        key,
        reason: 'is secured; only the person changes a secured variable, on the Pipelines page',
      });
      continue;
    }
    if (looksLikeSecret(key) && value !== '') {
      plan.refused.push({
        key,
        reason:
          'reads as a secret, so no value is written from a chat; the person adds it as a secured variable on the Pipelines page',
      });
      continue;
    }
    const problem = validate(key, value);
    if (problem) {
      plan.refused.push({ key, reason: problem });
      continue;
    }
    plan.set.push({ key, value });
  }
  for (const key of new Set(input.remove)) {
    const found = existing.get(key);
    if (!found) {
      plan.refused.push({ key, reason: 'is not set, so there is nothing to remove' });
    } else if (found.secured) {
      plan.refused.push({
        key,
        reason: 'is secured; only the person removes one, on the Pipelines page',
      });
    } else if (key in input.variables) {
      plan.refused.push({ key, reason: 'is both set and removed in one call' });
    } else {
      plan.remove.push(key);
    }
  }
  return plan;
}

export interface RenderedVariable {
  key: string;
  /** Null for a secured variable. */
  value: string | null;
  secured: boolean;
}

/** One set as the model reads it: a plain variable with its value, a secured one by name with its value omitted. */
export function renderVariableSet(title: string, variables: readonly RenderedVariable[]): string {
  if (variables.length === 0) return `${title}: none.`;
  return [
    `${title}:`,
    ...variables.map((variable) =>
      variable.secured
        ? `  ${variable.key} — secured, value omitted`
        : `  ${variable.key}=${variable.value ?? ''}`
    ),
  ].join('\n');
}

/** What a write did, as the model reads it. */
export function renderWriteOutcome(
  plan: VariableWritePlan,
  applied: { added: string[]; changed: string[]; removed: string[]; errors: string[] }
): string {
  const lines: string[] = [];
  const parts = [
    applied.added.length ? `added ${applied.added.join(', ')}` : '',
    applied.changed.length ? `changed ${applied.changed.join(', ')}` : '',
    applied.removed.length ? `removed ${applied.removed.join(', ')}` : '',
  ].filter(Boolean);
  lines.push(
    parts.length
      ? `${parts.join('; ')}.`
      : applied.errors.length === 0 && plan.refused.length === 0
        ? 'Nothing changed: every value was already as given.'
        : 'Nothing was written.'
  );
  if (applied.errors.length) lines.push(`The host refused: ${applied.errors.join('; ')}.`);
  if (plan.refused.length) {
    lines.push(
      `Left alone: ${plan.refused.map((entry) => `${entry.key} ${entry.reason}`).join('; ')}.`
    );
  }
  return lines.join('\n');
}
