/**
 * What an agent IS: a set of instructions and the tools it may use.
 *
 * There is no plan here — no steps, branches or loops for the platform to
 * walk. The agent is given its instructions, the run's input, and its
 * tools, and works out how to reach the goal itself: which tools to call,
 * in what order, and when to try again. What the platform keeps is the
 * hard limits around that autonomy, and those live in the org's settings
 * and the engine, not in the definition:
 *
 *   - active runtime (agentRunTimeoutMinutes, default 30) — only the time
 *     the agent holds control counts; waits on a person do not;
 *   - tool calls (agentRunToolCallBudget, default 150) per run;
 *   - no direct writes: a tool that changes something is never called by
 *     the agent — it is STAGED as an action batch that a separate executor
 *     runs once accepted (action-batch.ts).
 *
 * The instructions are prose, but structured: the drafting flow writes them
 * under the INSTRUCTION_SECTIONS headings, and the editor offers the same
 * skeleton. The structure is a convention for the model and the reader —
 * the validator does not require it, because a person who writes their
 * own instructions in a different shape is still writing instructions.
 *
 * This module is CLIENT-SAFE: the builder imports it into the browser.
 */

import { validateTriggerDrafts, type TriggerDraft } from './triggers';

/**
 * The instruction document's headings, in order — the skeleton the
 * drafting model writes to and the editor seeds a new agent with. Each
 * carries the question its section answers, which is what the drafting
 * prompt asks the model to fill in.
 */
export const INSTRUCTION_SECTIONS: readonly { heading: string; asks: string }[] = [
  { heading: 'Goal', asks: 'What outcome this agent exists to produce, in one or two sentences.' },
  {
    heading: 'Context',
    asks:
      'What the agent starts from — what triggers it and what that input contains — and any ' +
      'background it needs (who is involved, which systems are the source of truth).',
  },
  {
    heading: 'Approach',
    asks:
      'The suggested way to get there as a short numbered list. A guide, not a script: the ' +
      'agent may reorder, skip or retry as the situation calls for.',
  },
  {
    heading: 'Tools',
    asks: 'Which of the selected tools serve which part of the work, and anything to know about using them.',
  },
  {
    heading: 'Actions',
    asks:
      'The changes the agent may propose (tickets, messages, updates) and what each should ' +
      'contain. These are staged for acceptance, never made directly.',
  },
  {
    heading: 'Done when',
    asks: 'How the agent knows the goal is met — and when there is nothing to do at all.',
  },
  {
    heading: 'Rules',
    asks: 'Hard constraints: what never to do, what must always hold, when to ask a person.',
  },
];

/** The skeleton a blank agent starts from — one heading per section. */
export function instructionsSkeleton(): string {
  return INSTRUCTION_SECTIONS.map((section) => `## ${section.heading}\n\n`).join('\n');
}

/** The longest instruction document one agent may carry. */
export const MAX_INSTRUCTIONS_CHARS = 30_000;
/** How many tools one agent may select. Every one is a schema in every model call. */
export const MAX_AGENT_TOOLS = 60;
/**
 * A sanity bound on guardrails, not a style rule — guardrails are injected
 * in full on purpose, so length is the owner's cost choice; this only stops
 * a paste accident from parking a megabyte in every prompt.
 */
export const MAX_GUARDRAILS_CHARS = 1_000_000;
/**
 * Default wait a staged action batch (or an `ask_person` call that does not
 * set its own) gets before it is treated as declined/unanswered: four days.
 */
export const APPROVAL_DEFAULT_TIMEOUT_HOURS = 96;
/**
 * The wait cap used when no org settings are in hand — matches the org
 * setting's default (agentApprovalMaxWaitDays = 14). The live setting binds
 * at pause time.
 */
export const DEFAULT_APPROVAL_WAIT_CAP_HOURS = 14 * 24;
/**
 * API-trigger input names share this shape. Spaces are allowed mid-name —
 * these are labels people read, not identifiers — but not at either end,
 * which the normalizer's trim guarantees before validation sees them.
 */
export const VARIABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 _.-]{0,63}$/;

/**
 * The part of an agent a run snapshots (agent_runs.definition_snapshot):
 * a run executes the instructions and tool set as they were when it
 * started, even if the agent is edited while it runs or waits.
 */
export interface AgentDefinition {
  instructions: string;
  /** Tool names, deduplicated, in the owner's chosen order. */
  tools: string[];
}

export function isAgentDefinition(value: unknown): value is AgentDefinition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const doc: { instructions?: unknown; tools?: unknown } = value;
  return (
    typeof doc.instructions === 'string' &&
    Array.isArray(doc.tools) &&
    doc.tools.every((tool) => typeof tool === 'string')
  );
}

/** A definition out of untrusted JSON, or null when it is not one. */
export function parseAgentDefinition(value: unknown): AgentDefinition | null {
  return isAgentDefinition(value)
    ? { instructions: value.instructions, tools: [...value.tools] }
    : null;
}

/** What a save carries: the definition plus everything around it. */
export interface AgentDraft {
  name: string;
  instructions: string;
  tools: string[];
  triggers: TriggerDraft[];
  /** Wanting the agent on; enabling requires at least one trigger. */
  enabled: boolean;
  /** Org-configured model override; null = org default. */
  llmModelId: string | null;
  /**
   * The owner's standing rules — injected IN FULL into every model call,
   * binding over the instructions where the two conflict. Null = none.
   */
  guardrails: string | null;
  /** Unlocks the free `ask_person` tool: the agent may pause to ask its owner. */
  canAskQuestions: boolean;
  /**
   * Staged action batches are accepted without a person — unless the
   * org's policy or the fixed high-risk list says this one needs one
   * (act-approval.ts). Off by default: a new agent proposes, a person
   * accepts.
   */
  autoAcceptActions: boolean;
}

export interface ValidationIssue {
  /** Where the issue lives, e.g. 'instructions', 'tools.2' or 'triggers.0'. */
  path: string;
  message: string;
}

/** The slice of a tool catalog entry the validator needs. */
export interface ToolDescriptorLike {
  name: string;
  appOnly: boolean;
}

/** Trim, dedupe and coerce — never reject; that is validateAgentDraft's job. */
export function normalizeAgentDraft(draft: AgentDraft): AgentDraft {
  const guardrails = draft.guardrails?.trim() ? draft.guardrails : null;
  return {
    ...draft,
    name: draft.name.trim(),
    // Trailing whitespace only: leading indentation can be meaningful in
    // Markdown, and the editor's own blank skeleton lines are harmless.
    instructions: draft.instructions.trimEnd(),
    tools: [...new Set(draft.tools.map((tool) => tool.trim()).filter(Boolean))],
    guardrails,
    canAskQuestions: draft.canAskQuestions === true,
    autoAcceptActions: draft.autoAcceptActions === true,
  };
}

/** Whether the instructions say anything beyond the bare section headings. */
export function instructionsHaveContent(instructions: string): boolean {
  return instructions
    .split('\n')
    .some((line) => line.trim().length > 0 && !/^#{1,6}\s/.test(line.trim()));
}

export function validateAgentDraft(
  draft: AgentDraft,
  /** The OWNER's tool projection — the agent runs on the owner's grants. */
  tools: ToolDescriptorLike[]
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const available = new Map(tools.map((tool) => [tool.name, tool]));

  if (draft.name.trim().length === 0) {
    issues.push({ path: 'name', message: 'Give the agent a name.' });
  }
  if (draft.name.trim().length > 200) {
    issues.push({ path: 'name', message: 'Keep the name under 200 characters.' });
  }
  if (!instructionsHaveContent(draft.instructions)) {
    issues.push({
      path: 'instructions',
      message: 'Write the instructions — what the agent should achieve and how.',
    });
  }
  if (draft.instructions.length > MAX_INSTRUCTIONS_CHARS) {
    issues.push({
      path: 'instructions',
      message: `Keep the instructions under ${MAX_INSTRUCTIONS_CHARS.toLocaleString()} characters.`,
    });
  }
  if ((draft.guardrails?.length ?? 0) > MAX_GUARDRAILS_CHARS) {
    issues.push({
      path: 'guardrails',
      message: `The guardrails document is too long to inject — keep it under ${MAX_GUARDRAILS_CHARS.toLocaleString()} characters.`,
    });
  }
  if (draft.tools.length > MAX_AGENT_TOOLS) {
    issues.push({
      path: 'tools',
      message: `Select at most ${MAX_AGENT_TOOLS} tools — every one is described to the model on every call.`,
    });
  }
  draft.tools.forEach((name, index) => {
    const tool = available.get(name);
    if (!tool) {
      issues.push({
        path: `tools.${index}`,
        message: `The tool "${name}" is not available to this agent's owner — remove it or connect the account it needs.`,
      });
    } else if (tool.appOnly) {
      issues.push({
        path: `tools.${index}`,
        message: `The tool "${name}" only works inside the app and cannot be given to an agent.`,
      });
    }
  });

  issues.push(
    ...validateTriggerDrafts(draft.triggers).map((issue) => ({
      path: `triggers.${issue.index}`,
      message: issue.message,
    }))
  );
  if (draft.enabled && draft.triggers.length === 0) {
    issues.push({
      path: 'triggers',
      message: 'Add at least one trigger before turning the agent on.',
    });
  }
  return issues;
}

/** An agents row's columns → the definition a run snapshots. */
export function agentDefinitionOf(row: { instructions: string; tools: unknown }): AgentDefinition {
  return {
    instructions: row.instructions,
    tools: Array.isArray(row.tools)
      ? row.tools.filter((tool): tool is string => typeof tool === 'string')
      : [],
  };
}
