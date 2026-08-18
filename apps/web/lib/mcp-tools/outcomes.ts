/**
 * What a tool call can come back saying — enumerated, so a person can plan
 * for it before it happens.
 *
 * The agent builder shows each step's tool with the ways that tool can fail
 * ("The item couldn't be found", "You don't have access") and lets the
 * author choose, per condition, whether the step retries with guidance or
 * the agent stops. That requires the failure conditions to exist as a
 * finite, named list BEFORE any call is made — which nothing provided:
 * failures today are prose in an isError text block.
 *
 * This module is that list. Pure data, no I/O, importable from client and
 * server alike (the connector-catalog precedent). Resolution is layered so
 * 245 registration sites need no edits:
 *
 *   1. `_meta.outcomes` on a tool's registration — the long-term home, for
 *      tools that declare their own conditions at the definition site.
 *   2. `CURATED_OUTCOMES` here — hand-written entries for the tools people
 *      automate most, richer than the generic set.
 *   3. `genericOutcomes(kind)` — the default every other tool gets.
 *
 * Whatever the source, `other` is ALWAYS present: the builder always has a
 * catch-all row to offer, and the runtime always has somewhere to land a
 * failure it cannot classify. Codes are stable identifiers — saved agents
 * key their failure handling on them, so renaming one is a breaking change.
 */

export interface ToolFailureOutcome {
  /** Stable machine code; saved agents and run records key on this. */
  code: string;
  /** Human phrase for the builder, e.g. "The item couldn't be found". */
  label: string;
  /** One sentence shown under the label in the failure panel. */
  description: string;
  /** Whether "try again with corrective guidance" is a sensible offer. */
  retriable: boolean;
}

export interface ToolOutcomes {
  success: { label: string };
  failures: ToolFailureOutcome[];
}

/** The catch-all — appended to every set, curated or not. */
export const OTHER_FAILURE: ToolFailureOutcome = {
  code: 'other',
  label: 'Anything else goes wrong',
  description: 'A problem that does not match the conditions above.',
  retriable: true,
};

/**
 * The default failure set. `not-found` is retriable because corrective
 * guidance can fix a wrong key or ID; `no-permission` is not, because no
 * amount of retrying grants access.
 */
export const GENERIC_FAILURES: ToolFailureOutcome[] = [
  {
    code: 'not-found',
    label: "The item couldn't be found",
    description: 'The ticket, message, page, or file this step looks for does not exist.',
    retriable: true,
  },
  {
    code: 'no-permission',
    label: "You don't have access to do this",
    description: 'Your account is not allowed to perform this action.',
    retriable: false,
  },
  {
    code: 'invalid-input',
    label: "Something about the request wasn't accepted",
    description: 'A value was missing, malformed, or rejected by the service.',
    retriable: true,
  },
  {
    code: 'service-unavailable',
    label: "The service didn't respond",
    description: 'The other system is down, slow, or rate-limiting right now.',
    retriable: true,
  },
];

export function genericOutcomes(kind: 'read' | 'act'): ToolOutcomes {
  return {
    success:
      kind === 'read'
        ? { label: 'The information was found' }
        : { label: 'The action was completed' },
    failures: [...GENERIC_FAILURES, OTHER_FAILURE],
  };
}

/** A tool-specific condition plus the generic set it extends. */
function curated(
  successLabel: string,
  specific: ToolFailureOutcome[],
  omitGeneric: string[] = []
): ToolOutcomes {
  return {
    success: { label: successLabel },
    failures: [
      ...specific,
      ...GENERIC_FAILURES.filter((f) => !omitGeneric.includes(f.code)),
      OTHER_FAILURE,
    ],
  };
}

/**
 * Hand-written outcome sets for the tools people automate most. Living here
 * rather than at the registration sites keeps the seed reviewable in one
 * place; a site that later declares `_meta.outcomes` takes precedence.
 */
export const CURATED_OUTCOMES: Record<string, ToolOutcomes> = {
  jira_create_issue: curated('The issue was created', [
    {
      code: 'project-not-found',
      label: "The project couldn't be found",
      description: 'No project matches the key this step uses.',
      retriable: true,
    },
    {
      code: 'field-rejected',
      label: 'A field was rejected',
      description: 'Jira refused one of the values — a missing required field or a bad option.',
      retriable: true,
    },
  ]),
  jira_update_issue: curated('The issue was updated', [
    {
      code: 'field-rejected',
      label: 'A field was rejected',
      description: 'Jira refused one of the values — a missing required field or a bad option.',
      retriable: true,
    },
  ]),
  jira_transition_issue: curated('The issue was moved to the new status', [
    {
      code: 'transition-not-allowed',
      label: 'That status change is not allowed',
      description: "The workflow doesn't permit this move from the issue's current status.",
      retriable: true,
    },
  ]),
  jira_search_issues: curated('The search returned results', [
    {
      code: 'bad-query',
      label: "The search couldn't be understood",
      description: 'The search terms were rejected by Jira.',
      retriable: true,
    },
    {
      code: 'no-results',
      label: 'Nothing matched the search',
      description: 'The search ran fine but found no issues.',
      retriable: true,
    },
  ]),
  outlook_send_mail: curated('The email was sent', [
    {
      code: 'recipient-rejected',
      label: 'A recipient was rejected',
      description: 'An address was invalid or refused by the mail server.',
      retriable: true,
    },
    {
      code: 'attachment-too-large',
      label: 'An attachment was too large',
      description: 'The message exceeded the size the mail server accepts.',
      retriable: true,
    },
  ]),
  outlook_search_messages: curated('The search returned results', [
    {
      code: 'no-results',
      label: 'Nothing matched the search',
      description: 'The search ran fine but found no messages.',
      retriable: true,
    },
  ]),
  confluence_create_page: curated('The page was created', [
    {
      code: 'space-not-found',
      label: "The space couldn't be found",
      description: 'No Confluence space matches the one this step uses.',
      retriable: true,
    },
    {
      code: 'duplicate-title',
      label: 'A page with that title already exists',
      description: 'Confluence requires titles to be unique within a space.',
      retriable: true,
    },
  ]),
  sharepoint_upload_document: curated('The document was uploaded', [
    {
      code: 'file-too-large',
      label: 'The file was too large',
      description: 'The upload exceeded the size the site accepts.',
      retriable: false,
    },
  ]),
  jsm_create_request: curated('The request was created', [
    {
      code: 'request-type-invalid',
      label: "The request type didn't fit",
      description: 'The service desk rejected the request type or its required fields.',
      retriable: true,
    },
  ]),
  webex_send_message: curated('The message was sent', [
    {
      code: 'room-not-found',
      label: "The space couldn't be found",
      description: 'No WebEx space matches the one this step uses.',
      retriable: true,
    },
  ]),
  webex_note_to_self: curated('The note was posted', [
    {
      code: 'space-unavailable',
      label: "A private space couldn't be found or created",
      description: 'WebEx offered no space containing only the user and refused to create one.',
      retriable: true,
    },
  ]),
};

function isFailureEntry(value: unknown): value is ToolFailureOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const entry: { code?: unknown; label?: unknown; description?: unknown; retriable?: unknown } =
    value;
  return (
    typeof entry.code === 'string' &&
    typeof entry.label === 'string' &&
    typeof entry.description === 'string' &&
    typeof entry.retriable === 'boolean'
  );
}

/** Light shape guard — `_meta` is untyped and travels across module seams. */
function isDeclaredOutcomes(value: unknown): value is ToolOutcomes {
  if (typeof value !== 'object' || value === null) return false;
  const candidate: { success?: unknown; failures?: unknown } = value;
  if (typeof candidate.success !== 'object' || candidate.success === null) return false;
  const success: { label?: unknown } = candidate.success;
  if (typeof success.label !== 'string') return false;
  if (!Array.isArray(candidate.failures)) return false;
  return candidate.failures.every(isFailureEntry);
}

function withCatchAll(outcomes: ToolOutcomes): ToolOutcomes {
  if (outcomes.failures.some((f) => f.code === OTHER_FAILURE.code)) return outcomes;
  return { ...outcomes, failures: [...outcomes.failures, OTHER_FAILURE] };
}

/**
 * The outcome set for a tool: registration-declared, else curated, else
 * generic — with the `other` catch-all guaranteed regardless of source.
 */
export function resolveOutcomes(
  name: string,
  kind: 'read' | 'act',
  meta?: { outcomes?: unknown }
): ToolOutcomes {
  if (isDeclaredOutcomes(meta?.outcomes)) return withCatchAll(meta.outcomes);
  const curatedSet = CURATED_OUTCOMES[name];
  if (curatedSet) return withCatchAll(curatedSet);
  return genericOutcomes(kind);
}

/** The `_meta` key the runtime reads a classified outcome code from. */
export const OUTCOME_META_KEY = 'renkei/outcome';

/**
 * An error result that names its condition. Handlers adopt this gradually —
 * the enumeration above never depends on it, but a handler that uses it
 * gives the agent runtime an exact classification instead of a heuristic.
 */
export function outcomeError(
  code: string,
  text: string
): {
  content: { type: 'text'; text: string }[];
  isError: true;
  _meta: Record<string, string>;
} {
  return {
    content: [{ type: 'text', text }],
    isError: true,
    _meta: { [OUTCOME_META_KEY]: code },
  };
}
