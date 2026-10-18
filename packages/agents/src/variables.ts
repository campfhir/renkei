/**
 * The named values a run starts from.
 *
 * Two provenances:
 *   - builtins: `user.name`, `user.email`, `today` — resolved at run time
 *     from the identity spine and the clock, listed under "Facts" in the
 *     run's opening message;
 *   - trigger inputs: `trigger.<key>` — what the attached triggers provide
 *     (an email trigger provides subject/body/from; an API trigger
 *     provides whatever inputs its author named), listed fenced as
 *     untrusted under "What triggered this run".
 *
 * The builder lists both beside the instructions so an author knows what
 * the agent will be handed, and the drafting prompt names them so the
 * instructions it writes refer to them.
 */

export interface VariableDescriptor {
  /** The value's name, e.g. 'user.email' or 'trigger.subject'. */
  name: string;
  /** Human label, e.g. "Your email". */
  label: string;
  description: string;
  source: 'builtin' | 'trigger';
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
];

/**
 * The vars whose values came from OUTSIDE the author's hand — the trigger's
 * payload (a mail, a message, an API caller's state). Only these carry a
 * stranger's words into the prompt as they were written.
 */
export function isUntrustedVariable(name: string): boolean {
  return name.startsWith('trigger.');
}
