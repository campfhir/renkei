'use client';

/**
 * "Guardrails" — the agent's standing rules, edited in the builder rail.
 *
 * The document is free-form ON PURPOSE: role, sources of truth and their
 * precedence, content rules, hard rules — whatever the owner writes is
 * injected IN FULL into every model call of every run, never truncated (a
 * clipped "no PHI" rule is worse than none), and binds over the
 * instructions where the two conflict. Length is therefore the owner's own
 * cost decision, and the helper text says so instead of a character
 * counter enforcing taste.
 *
 * What the agent may USE is the tool selection, not this panel: a tool the
 * agent was not given is not something it can reach at all.
 */

const textareaClass = (invalid: boolean) =>
  `mt-2 w-full rounded-md border bg-white px-3 py-2 font-mono text-xs leading-relaxed dark:bg-gray-900 ${
    invalid ? 'border-red-400 dark:border-red-700' : 'border-gray-300 dark:border-gray-700'
  }`;

export function GuardrailsPanel({
  guardrails,
  onGuardrailsChange,
  issues,
}: {
  guardrails: string;
  onGuardrailsChange: (next: string) => void;
  issues: string[];
}) {
  return (
    <section className="rounded-lg border border-gray-200 p-4 dark:border-gray-800">
      <h2 className="text-sm font-semibold">Guardrails</h2>
      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
        Standing rules the agent always follows — they win where they and the instructions
        disagree. Sent with every model call in full; longer documents cost more per call.
      </p>
      <textarea
        value={guardrails}
        onChange={(event) => onGuardrailsChange(event.target.value)}
        rows={6}
        placeholder={
          'e.g.\n- Draft only — never send anything to a customer.\n- Never fabricate numbers; write "(not set)" instead.'
        }
        aria-label="Guardrails"
        aria-invalid={issues.length > 0 || undefined}
        className={textareaClass(issues.length > 0)}
      />
      {issues.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {issues.map((issue) => (
            <li key={issue} className="text-xs text-red-600 dark:text-red-400">
              {issue}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
