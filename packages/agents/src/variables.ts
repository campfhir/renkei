/**
 * The variables a step can reference as chips.
 *
 * Three provenances, one namespace rule each:
 *   - builtins: `user.name`, `user.email`, `today` — resolved at run time
 *     from the identity spine and the clock.
 *   - trigger inputs: `trigger.<key>` — what the attached triggers provide
 *     (an email trigger provides subject/body/from; an API trigger provides
 *     whatever inputs its author named).
 *   - step results: bare names bound by an earlier step's `saveAs`.
 *
 * The builder unions these into the autocomplete; the validator rejects a
 * chip naming none of them.
 */

export interface VariableDescriptor {
  /** The name a var chip carries, e.g. 'user.email' or 'trigger.subject'. */
  name: string;
  /** Human label for the chip and autocomplete row, e.g. "Your email". */
  label: string;
  description: string;
  source: 'builtin' | 'trigger' | 'step';
}

export const BUILTIN_VARIABLES: VariableDescriptor[] = [
  {
    name: 'user.name',
    label: 'Your name',
    description: "The agent owner's display name.",
    source: 'builtin',
  },
  {
    name: 'user.email',
    label: 'Your email address',
    description: "The agent owner's email address.",
    source: 'builtin',
  },
  {
    name: 'today',
    label: "Today's date",
    description: 'The date the agent runs, e.g. 2026-08-16.',
    source: 'builtin',
  },
  {
    name: 'attempt',
    label: 'This try',
    description: 'Which try of this step is running, counting from 1.',
    source: 'builtin',
  },
  {
    name: 'attempt.max',
    label: 'Total tries',
    description: "How many tries this step is allowed, from the step's own setting.",
    source: 'builtin',
  },
];

/**
 * The attempt chips, bound for one try of one step.
 *
 * Kept here rather than in the run's variable map because they are the only
 * builtins that change WITHIN a run: `today` and the identity are fixed for
 * the whole thing, while these two differ on every retry of every step. The
 * engine and the prompt builder both layer this over the run's variables at
 * the point they know which try they are on.
 *
 * `attempt` counts from 1, so an instruction reading "try [attempt] of
 * [attempt.max]" says "try 1 of 3" on the first pass — the wording an
 * author expects, and the reason this is not zero-based.
 */
export function attemptVariables(attempt: number, maxAttempts: number): Record<string, string> {
  return { attempt: String(attempt), 'attempt.max': String(maxAttempts) };
}
