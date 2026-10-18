/**
 * The run prompts — the EXACT text the engine sends the model, in the
 * shared package so every surface that claims to show "what the agent
 * sees" (the agent page's markdown export, the drafting preview) renders
 * through THIS code and cannot drift.
 *
 * A run is one conversation. The SYSTEM prompt carries everything that is
 * constant for the run — the frame (how to work, the limits, staging), the
 * owner's guardrails, the agent's instructions, its knowledge index and
 * memory — so from the second model call on it is a prompt-cache read. The
 * opening USER message carries this run's input: who it runs for, when,
 * what triggered it. After that the conversation is the agent's own tool
 * calls and their results, with a short budget line riding on each batch
 * of results so the agent always knows what it has left.
 *
 * The message/tool-def types here are structural twins of
 * @renkei/agent-llm's LlmMessage/LlmToolDef (text blocks only — prompts
 * are text) so this package does not depend on the LLM layer.
 */

import { UNTRUSTED_RULE, untrustedBlock } from './untrusted';

/** Structural twin of @renkei/agent-llm's text-only message. */
export interface PromptMessage {
  role: 'user';
  content: { type: 'text'; text: string }[];
}

/** Structural twin of @renkei/agent-llm's tool definition. */
export interface PromptToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export { UNTRUSTED_RULE, UNTRUSTED_TAG, untrustedBlock } from './untrusted';

/**
 * The most of one tool result the model reads. A result is in the
 * conversation for the rest of the run, so this is priced per turn, not
 * per call; the transcript budget (engine) elides the oldest results when
 * a long run's conversation grows past what a model can hold.
 */
export const TOOL_RESULT_CHARS = 30_000;
/** The longest `result` a finished run may hand on (to a chained agent, the run page). */
export const RUN_RESULT_CHARS = 12_000;

export const RESOLVE_TIME_TOOL = 'resolve_time';

/**
 * Deterministic date arithmetic, offered on every run and FREE — answered
 * in-process, never sent to the gateway, never counted against the run's
 * tool-call budget.
 *
 * It exists because models are confidently wrong at this. "Yesterday at
 * 19:00 in America/Los_Angeles, as UTC" needs a calendar shift, a
 * wall-clock set and a DST-aware conversion, and a wrong answer is
 * indistinguishable from a right one until a search quietly covers the
 * wrong window. Charging for the call would push a model toward guessing
 * instead — which is the failure this is meant to remove.
 */
export const RESOLVE_TIME_DEF: PromptToolDef = {
  name: RESOLVE_TIME_TOOL,
  description:
    'Compute an exact timestamp instead of working one out yourself. Say which timezone, ' +
    'how far to move (amount + unit), and optionally the time of day; you get back the ' +
    'instant in UTC, how it reads locally and its day of the week. Ask this rather than ' +
    'naming a weekday yourself — "which day is the 24th?" is a guess otherwise. Free: it never counts against your tool budget, so use it whenever a ' +
    'date or time matters — never hand-calculate one.',
  inputSchema: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description:
          'IANA zone the times are expressed in, e.g. "America/Los_Angeles" or "UTC". ' +
          'Use the timezone the request is written in, not your own.',
      },
      amount: {
        type: 'number',
        description:
          'How far to move, signed: -1 with unit "day" is yesterday, 2 with "week" is a ' +
          'fortnight from now. Omit for "today"/"now".',
      },
      unit: {
        type: 'string',
        enum: ['minute', 'hour', 'day', 'week', 'month', 'year'],
        description:
          'The unit for amount. minute/hour are exact elapsed time; day and larger keep the ' +
          'same wall-clock time across daylight-saving changes.',
      },
      atTime: {
        type: 'string',
        description:
          'Time of day in the target zone, 24-hour "HH:MM" — e.g. "19:00" for 7pm. Applied ' +
          'after the shift.',
      },
      anchor: {
        type: 'string',
        description:
          'What to measure from: "now" (default) or an ISO 8601 instant such as a timestamp ' +
          'from an earlier tool result.',
      },
      startOf: {
        type: 'string',
        enum: ['hour', 'day', 'week', 'month'],
        description: 'Snap to the beginning of this unit. Ignored when atTime is given.',
      },
      endOf: {
        type: 'string',
        enum: ['hour', 'day', 'week', 'month'],
        description: 'Snap to the last minute of this unit. Ignored when atTime is given.',
      },
    },
    required: ['timezone'],
  },
};

export const FINISH_RUN_TOOL = 'finish_run';

/**
 * How a run ends. The agent decides when the goal is met — there is no
 * plan for the platform to walk to its end — and says so here, once.
 */
export const FINISH_RUN_DEF: PromptToolDef = {
  name: FINISH_RUN_TOOL,
  description:
    'End this run. Call it as soon as the goal is met, when there turns out to be nothing to ' +
    'do, or when you are sure the goal cannot be reached within your limits — do not keep ' +
    'working to fill the time or the budget. Free.',
  inputSchema: {
    type: 'object',
    properties: {
      outcome: {
        type: 'string',
        enum: ['done', 'nothing_to_do', 'failed'],
        description:
          '"done": the goal is met. "nothing_to_do": this input did not call for any work ' +
          '(out of scope, already handled) — not a failure. "failed": the goal could not be ' +
          'reached; say why in summary.',
      },
      summary: {
        type: 'string',
        description:
          'Two or three sentences for the owner: what you found and what was done (or why ' +
          'not), with identifiers.',
      },
      result: {
        type: 'string',
        description: `Optional: the run's product for whoever comes next — an agent chained after this one sees it. At most ${RUN_RESULT_CHARS.toLocaleString()} characters.`,
      },
      quiet: {
        type: 'boolean',
        description:
          'With "nothing_to_do": true ends without notifying anyone or starting chained agents.',
      },
    },
    required: ['outcome', 'summary'],
  },
};

export const STAGE_ACTIONS_TOOL = 'stage_actions';

/** What the stage_actions description lists for one stageable tool. */
export interface StageableToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The ONLY way an agent changes anything (action-batch.ts). The tools it
 * may stage are not offered as callable tools at all — their schemas are
 * described here, inside this one tool's description, so the agent knows
 * how to fill in each action's args without being able to call it.
 */
export function buildStageActionsDef(stageable: readonly StageableToolInfo[]): PromptToolDef {
  const catalog = stageable
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description.trim()}\n  args schema: ${JSON.stringify(tool.inputSchema)}`
    )
    .join('\n');
  return {
    name: STAGE_ACTIONS_TOOL,
    description:
      'Propose changes — the only way you can create, update, send or delete anything. You ' +
      'cannot call these tools yourself: list the actions here, in the order they should run, ' +
      'each with its args and the reason it is needed. The batch is accepted (by the owner, or ' +
      'automatically if they allow it) and run for you by a separate process, in order, ' +
      'stopping at the first failure; this call then returns each action’s outcome. Your ' +
      'clock is stopped while you wait. Put everything that belongs together into ONE batch ' +
      'rather than staging actions one at a time; stage again only for what the results show ' +
      'is still needed. Each action counts once against your tool budget.\n\n' +
      `Tools you can stage:\n${catalog || '(none — this agent has no action tools)'}`,
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'One or two sentences for the person accepting: what this batch does and why.',
        },
        actions: {
          type: 'array',
          description: 'The actions, in the order they run.',
          items: {
            type: 'object',
            properties: {
              tool: {
                type: 'string',
                ...(stageable.length > 0 ? { enum: stageable.map((tool) => tool.name) } : {}),
              },
              args: { type: 'object', description: "The tool's arguments, per its schema above." },
              reason: { type: 'string', description: 'Why this action is part of the plan.' },
            },
            required: ['tool', 'args', 'reason'],
          },
        },
        timeoutHours: {
          type: 'number',
          description:
            'How long to wait for acceptance before treating the batch as declined. Default 96.',
        },
      },
      required: ['summary', 'actions'],
    },
  };
}

export const REMEMBER_TOOL = 'remember';

/**
 * Free and deliberately its own call: memory is written only when the
 * agent has decided there is something future runs need — most runs
 * never call this, which is correct, not an omission.
 */
export const REMEMBER_DEF: PromptToolDef = {
  name: REMEMBER_TOOL,
  description:
    'Record one fact FUTURE runs of this agent need and could not rediscover — chiefly what ' +
    'this run acted on (e.g. "replied to message 123 about the outage") or a durable ' +
    'preference learned. One sentence with identifiers. Not a summary of the run, not routine ' +
    'progress. Free; call it more than once if there is more than one fact to keep.',
  inputSchema: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'The fact to remember, one sentence with identifiers.' },
    },
    required: ['note'],
  },
};

export const ASK_PERSON_TOOL = 'ask_person';

/**
 * Free, offered only when the agent's `canAskQuestions` is on. Pauses the
 * run behind a question card; the answer (or a timeout) comes back as
 * this call's result, and the run's clock is stopped meanwhile.
 */
export const ASK_PERSON_DEF: PromptToolDef = {
  name: ASK_PERSON_TOOL,
  description:
    'Pause and ask the owner something, instead of guessing or failing for lack of it. The ' +
    'answer (or a note that nobody answered in time) comes back as this call’s result; your ' +
    'clock is stopped while you wait. Put every question you have right now into ONE call — ' +
    'group and paragraph entries in form let several questions share one readable card. Free.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Plain prose: what you need and why, shown above any form fields.',
      },
      form: {
        type: 'array',
        description:
          'Optional structure beyond the open question in message — at most 40 entries total ' +
          "(a group's members count toward that). Each entry is one of: " +
          '{kind:"field", name, label, type: "text"|"longtext"|"number"|"choice"|"multi"|"date", ' +
          'required, options?, min?, max?, help?, key?} — an answerable control, "key" being the ' +
          "destination's own field id (e.g. a Jira custom field) when the answer is headed " +
          'somewhere specific; {kind:"paragraph", text} — context with nothing to answer; or ' +
          '{kind:"group", label, nodes} — one level of fields/paragraphs clustered under a ' +
          'heading (groups do not nest). A two-option "choice" reads as yes/no buttons.',
        items: { type: 'object' },
      },
      timeoutHours: {
        type: 'number',
        description:
          'How long to wait for an answer before treating it as unanswered. Default 96 (4 days).',
      },
    },
    required: ['message'],
  },
};

/** The platform's own tools — answered by the engine, never by the gateway, never billed. */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  FINISH_RUN_TOOL,
  REMEMBER_TOOL,
  RESOLVE_TIME_TOOL,
  ASK_PERSON_TOOL,
];

/** The run's limits as the model is told them. */
export interface RunLimits {
  /** agentRunTimeoutMinutes — active time only. */
  minutes: number;
  /** agentRunToolCallBudget. */
  toolCalls: number;
}

/** The frame: how an agent works on this platform. Constant per run. */
export function runFrame(limits: RunLimits, options: { canAsk: boolean }): string {
  return [
    'You are an autonomous agent working for the person who owns you, under their account and permissions. Your instructions below say what to achieve; how to get there is your judgment.',
    'Work toward the goal with the tools you have: look things up, check what you find, and when a call fails or a result is not what you need, try a different way — you may retry as you see fit.',
    `You have hard limits for this run: ${limits.toolCalls} tool calls and ${limits.minutes} minutes of active time. The time you spend waiting on a person is not counted. You are told what is left as you go. These are ceilings, not targets: finish as soon as the goal is met, and do not spend calls double-checking what you already know. If the limits run out the run ends unfinished.`,
    'You cannot change anything directly. Reading is yours; every change — creating, updating, sending, deleting — is proposed with stage_actions, accepted (by the owner, or automatically where they allow it), and carried out for you, after which you see each outcome. Stage complete, ready-to-run actions; group what belongs together into one batch.',
    options.canAsk
      ? 'When you need something only the owner knows, ask with ask_person rather than guessing. Do not ask what you can find out yourself.'
      : 'You cannot ask the owner questions during this run: when something is genuinely ambiguous, take the most conservative reading and say so in your summary.',
    'End with finish_run exactly once: "done" when the goal is met, "nothing_to_do" when this input called for no work, "failed" when you are sure it cannot be done.',
    'You may be shown "What you remember" (notes from this agent’s earlier runs) and "Your knowledge notes". Use them to avoid repeating work already done. When there is a fact future runs must know to avoid repeating or contradicting this one, call remember.',
    UNTRUSTED_RULE,
  ].join('\n\n');
}

/** The run-constant context around the frame. */
export interface RunContextInput {
  agentName: string;
  /** The agent's instructions, verbatim. */
  instructions: string;
  /** The owner's standing guardrails — injected in full, never clipped. */
  guardrailsText?: string;
  /** Rendered agent knowledge notes index, already bounded. */
  knowledgeText?: string;
  /** Rendered agent memory (summary + recent entries), already bounded. */
  memoryText?: string;
}

/**
 * The whole system prompt. Order: frame, guardrails, instructions,
 * knowledge, then memory LAST — memory is the one part that can change
 * mid-run (a `remember` call), and a change invalidates the cached prefix
 * only from where it sits.
 */
export function runSystemPrompt(
  limits: RunLimits,
  options: { canAsk: boolean },
  context: RunContextInput
): string {
  return [
    runFrame(limits, options),
    ...(context.guardrailsText
      ? [
          `Standing guardrails from your owner (binding — where they and the instructions conflict, the guardrails win):\n${context.guardrailsText}`,
        ]
      : []),
    `Your instructions (agent “${context.agentName}”):\n${context.instructions}`,
    ...(context.knowledgeText
      ? [
          'Your knowledge notes — an INDEX of what this agent keeps, newest first. Short notes are shown whole; longer ones show only their title and id, and agent_knowledge_list returns the full text when one looks relevant. Do not assume a note says what its title suggests:\n' +
            context.knowledgeText,
        ]
      : []),
    ...(context.memoryText
      ? [
          `What you remember (notes from this agent’s earlier runs, oldest first — check it before acting on something an earlier run may already have handled):\n${context.memoryText}`,
        ]
      : []),
  ].join('\n\n');
}

export interface RunOpeningInput {
  /** user.name, user.email, today, now — the platform's own facts. */
  facts: Record<string, string>;
  /** What the trigger delivered, `trigger.*` keys — fenced as untrusted. */
  triggerValues: Record<string, string>;
  /** How the run started, in words: "Started by hand", "Scheduled", … */
  startedBy: string;
  /** A note from the owner who resumed this run, when they left one. */
  resumeGuidance?: string;
  /** Set when this opening is a resume of a failed run: what happened before. */
  resumedAfter?: string;
}

/** The first user message: this run's input. */
export function buildRunOpening(input: RunOpeningInput): PromptMessage {
  const facts = Object.entries(input.facts)
    .map(([name, value]) => `- ${name}: ${value}`)
    .join('\n');
  const triggers = Object.entries(input.triggerValues);
  const parts = [
    `${input.startedBy}. Work toward your goal now.`,
    ...(facts ? [`Facts:\n${facts}`] : []),
    triggers.length > 0
      ? `What triggered this run:\n${triggers.map(([name, value]) => `${name}:\n${untrustedBlock(name, value)}`).join('\n')}`
      : 'Nothing was delivered with this run beyond the facts above.',
  ];
  return { role: 'user', content: [{ type: 'text', text: parts.join('\n\n') }] };
}

/**
 * The message a resumed run continues with: the owner picked a failed run
 * back up, and their note — when they wrote one — is binding.
 */
export function resumeMessage(input: { failure: string | null; guidance: string | null }): string {
  return [
    `The run stopped here${input.failure ? `: ${input.failure}` : ''}. The owner has resumed it, with a fresh budget.`,
    input.guidance
      ? `Their guidance — binding for how you continue: ${input.guidance}`
      : 'They left no note: look at why it stopped and take a different approach where that helps.',
  ].join(' ');
}

/** The line riding on each batch of tool results. */
export function budgetLine(left: { toolCalls: number; minutes: number }): string {
  const calls = Math.max(0, left.toolCalls);
  const minutes = Math.max(0, Math.floor(left.minutes));
  const urgency =
    calls <= 5 || minutes <= 2
      ? ' Wrap up now: finish with what you have, or stage what is still needed.'
      : '';
  return `[Budget left: ${calls} tool calls, ${minutes} min active time.${urgency}]`;
}
