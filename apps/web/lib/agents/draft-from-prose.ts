/**
 * One block of prose → a drafted step list, chips included.
 *
 * The user describes the whole automation in their own words; the org
 * model splits it into steps and marks tools/variables with {{tool:x}} /
 * {{var:y}} tokens. That token syntax exists ONLY on this wire — parsing
 * here turns it into the segment arrays the builder edits, and every
 * token is verified: a tool the caller does not have becomes plain text,
 * never a chip the validator would bounce. The user reviews and edits the
 * result in the builder like anything they typed themselves; nothing is
 * saved by this step.
 *
 * Two loops guard quality. The STRUCTURAL loop feeds parse problems back
 * for one corrective round trip. The GAP-CLOSING loop (refineWithReview)
 * then runs the save-time critic against the usable draft and hands its
 * concerns back to the drafting model — which closes what the description
 * supports and asks the USER (via "questions") for what it does not,
 * because a wrong guess acted on is worse than a question. Concerns still
 * open when the rounds or the budget run out ride back on the draft.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  APPROVAL_DEFAULT_TIMEOUT_HOURS,
  BUILTIN_VARIABLES,
  MAX_BRANCH_DEPTH_V3,
  MAX_BRANCH_PATHS,
  MAX_CONTAINER_DEPTH,
  MAX_LOOP_ITERATIONS,
  MAX_SCHEDULE_RULES,
  LOOP_DEFAULT_ATTEMPTS,
  LOOP_DEFAULT_ITERATIONS,
  MAX_STEPS,
  TRIGGER_EVENT_CATALOG,
  flattenActionSteps,
  isBranchStep,
  isValidTimezone,
  CURRENT_STEPS_VERSION,
  customOutcomeSlug,
  normalizeMatchForEvent,
  triggerEventById,
  validateMatchForEvent,
  walkSteps,
  type ActionStep,
  type AgentStepNode,
  type AgentStepsDoc,
  type BranchPath,
  type FailureHandling,
  type GroupStep,
  type InstructionSegment,
  type LoopStep,
  type Recurrence,
  type TerminalStep,
  type TriggerDraft,
  type Weekday,
} from '@renkei/agents';
import { resolveAgentLlm, type LlmMessage, type ResolvedLlm } from '@renkei/agent-llm';
import { getOrgSettings } from '@renkei/settings';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { friendlyToolName } from '@/lib/tool-name';
import { buildAgentReviewPrompt, parseAgentReviewReply } from '@/lib/agents/describe';
import type { ReviewNote } from '@/lib/agents/notes';
import { logger } from '@/lib/logger';

// Generous on purpose: reasoning models (Foundry deployments especially)
// routinely take over a minute on a long description, and cutting them off
// wastes the whole spend. The builder shows staged progress meanwhile.
const DRAFT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_TOKENS = 4_096;
const MAX_PROSE_CHARS = 4_000;
const DRAFT_SYSTEM =
  'You turn plain-language automation descriptions into structured steps. You reply with strict JSON.';

/** Gap-closing rounds: review → redraft, at most this many redrafts. */
const MAX_REFINE_ROUNDS = 2;
/** A redraft needs real time; below this remaining budget, ship what we have. */
const REFINE_MIN_BUDGET_MS = 60_000;
/** The reviewer is a small call; give it this much at most. */
const REVIEW_TIMEOUT_MS = 25_000;

/** Segments → the wire's token syntax, so current steps round-trip exactly. */
function segmentsToTokens(segments: InstructionSegment[]): string {
  return segments
    .map((segment) => {
      switch (segment.t) {
        case 'text':
          return segment.v;
        case 'tool':
          return `{{tool:${segment.name}}}`;
        case 'var':
          return `{{var:${segment.name}}}`;
      }
    })
    .join('');
}

/**
 * Current nodes → the numbered sN lines revisions quote. Pre-order over the
 * whole tree so `from` ids can name nodes inside branch paths too.
 */
function currentLinesOf(nodes: AgentStepNode[]): string {
  return walkSteps(nodes)
    .map(({ node, ordinal, depth }) => {
      const indent = '  '.repeat(depth - 1);
      switch (node.kind) {
        case 'branch': {
          const routes = node.paths.map((path) => `"${path.name}"`).join(' | ');
          return (
            `${indent}s${ordinal + 1}. [branch] "${node.name}" — decides: ${segmentsToTokens(node.condition)}` +
            ` (paths: ${routes}; the last is the fallback; the indented steps below belong to those paths` +
            (node.failurePath
              ? `; a failure route "${node.failurePath.name}" runs only if the decision itself fails`
              : '') +
            ')'
          );
        }
        case 'loop': {
          const collects = node.collectVar
            ? `; collects "${node.collectFrom}" into "${node.collectVar}"`
            : '';
          return node.mode === 'foreach'
            ? `${indent}s${ordinal + 1}. [loop] "${node.name}" — for each {{var:${node.itemVar}}} in {{var:${node.itemsVar}}} (at most ${node.maxIterations} rounds${collects}; the indented steps below are its body)`
            : `${indent}s${ordinal + 1}. [loop] "${node.name}" — repeats until: ${segmentsToTokens(node.condition)} (at most ${node.maxIterations} rounds${collects}; the indented steps below are its body)`;
        }
        case 'group':
          return `${indent}s${ordinal + 1}. [group] "${node.name}" — groups the indented steps below`;
        case 'terminal': {
          const channels = [
            ...(node.notifyEmail ? ['email'] : []),
            ...(node.notifyWebex ? ['webex'] : []),
          ];
          return (
            `${indent}s${ordinal + 1}. [end] "${node.name}" — ends the whole run as ${node.result}` +
            (channels.length > 0
              ? `; notifies via ${channels.join('+')} with: ${segmentsToTokens(node.message)}`
              : '; no notification')
          );
        }
        case 'action':
        case undefined:
          return (
            `${indent}s${ordinal + 1}. "${node.name}" — ${segmentsToTokens(node.instruction)}` +
            (node.saveAs ? ` (saves result as "${node.saveAs}")` : '') +
            (node.needsApproval
              ? ` [needs approval before this tool call fires, up to ${node.approvalTimeoutHours ?? APPROVAL_DEFAULT_TIMEOUT_HOURS}h; if not approved, skipped and the automation continues]`
              : '')
          );
        default: {
          const unhandled: never = node;
          throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
        }
      }
    })
    .join('\n');
}

/** A trigger-provided variable with the catalog's explanation of what it is. */
export interface TriggerVarInfo {
  name: string;
  description: string;
}

/** Another agent the caller owns, offered as an agent-finished trigger target. */
export interface AgentOption {
  id: string;
  name: string;
}

/**
 * Present when the builder has NO triggers yet and wants the draft to
 * propose them from the prose — and only then: with triggers already
 * configured, proposing more would duplicate what the user set up.
 */
interface TriggerOffer {
  otherAgents: AgentOption[];
}

function promptOf(
  text: string,
  tools: ToolDescriptor[],
  currentSteps: AgentStepNode[],
  triggerVars: TriggerVarInfo[],
  triggerOffer: TriggerOffer | null,
  guardrails: string | null,
  offerGuardrails: boolean,
  maxSteps: number
): string {
  const toolLines = tools
    .filter((tool) => !tool.appOnly)
    .map(
      (tool) =>
        // The FULL description, deliberately: the drafting model never sees
        // input schemas, so a tool's description is its only account of what
        // the tool needs and offers. This used to clip at 100 characters,
        // which cut most descriptions mid-sentence — steps were drafted
        // against tools whose requirements (a reporter input, a bulk
        // variant, a "prefer X over Y" rule) lived in the part the model
        // never read. Whitespace flattens so each tool stays one line.
        `- ${tool.name} (${friendlyToolName(tool.name, tool.title)}): ` +
        `${(tool.description ?? '').replace(/\s+/g, ' ').trim()}` +
        ` | failure codes: ${tool.outcomes.failures.map((failure) => failure.code).join(', ')}`
    )
    .join('\n');
  const varLines = [
    ...BUILTIN_VARIABLES.map((variable) => `- ${variable.name}: ${variable.description}`),
    ...triggerVars.map((variable) => `- ${variable.name}: ${variable.description}`),
  ].join('\n');

  const revising = currentSteps.length > 0;
  const currentLines = currentLinesOf(currentSteps);

  return [
    revising
      ? 'A user wants to CHANGE an existing automation. Apply exactly the change they describe — add, remove, reorder, or tweak steps as asked — and return the FULL revised step list. Echo steps the change does not touch VERBATIM (same instruction tokens, same saveAs).'
      : 'A user described an automation in plain words. Split it into ordered steps for a step-runner.',
    ...(guardrails
      ? [
          '',
          'The automation carries these STANDING GUARDRAILS the owner wrote — every run obeys ' +
            'them, and every drafted step must respect them. Never draft a step that violates ' +
            'one; when the description asks for something they forbid, add a question to ' +
            '"questions" instead of drafting the violation:',
          '"""',
          guardrails,
          '"""',
          '',
        ]
      : []),
    'Rules:',
    '- Each step does ONE thing and may use AT MOST ONE tool from the list below (a step may also be pure reasoning with no tool).',
    '- When a step covers MANY items (a sprint of issues, a folder of mail, a search result set), choose the bulk tool (named *_bulk_*) or a single search over per-item tools — one step, one call, never one step per item.',
    '- Mark the tool in the instruction as {{tool:tool_name}} and reference known variables as {{var:name}}. Use ONLY tools and variables from the lists.',
    '- When a later step needs an earlier step\'s result, give the earlier step a short "saveAs" name (starts with a letter; then letters, numbers, spaces, ".", "-" or "_"; at most 64 characters — e.g. "the ticket") and reference it as {{var:the ticket}}.',
    '- Every "saveAs" name must be UNIQUE — never reuse a name across steps. Later references use the exact earlier name.',
    '- When the description says the flow ENDS at a step on success, set that step\'s "onSuccess" to "stop"; when it should end silently doing nothing (no reply, no follow-up — e.g. "if it\'s not relevant, ignore it"), use "stop-quiet". For CONDITIONAL endings keep the condition in the instruction words ("If …, … and stop here" / "…stop silently") — the runner honors those at runtime.',
    '- Steps run strictly in order — but people rarely DESCRIBE them in order ("before all that ' +
      'you might need to…", "first look up…"). Reorder into the true execution sequence: gather ' +
      'context first, look things up, then act on what was found.',
    '- When the description forks on a condition ("if a ticket exists, comment on it; ' +
      'otherwise create one"), use a BRANCH object in the steps array: {"kind": "branch", ' +
      '"name": short label, "condition": the deciding question in plain words (may use ' +
      '{{var:...}}, NEVER {{tool:...}} — do any tool work in a step BEFORE the branch and ' +
      `save the result), "paths": 2 to ${MAX_BRANCH_PATHS} routes, each {"label": short path name, ` +
      '"steps": array of steps (same shape as top-level steps; may be empty — an empty path ' +
      'just continues)}. The LAST path is the fallback taken when nothing else clearly ' +
      'applies. After a path finishes, the automation continues with the steps AFTER the ' +
      `branch. Branches may nest at most ${MAX_BRANCH_DEPTH_V3} levels deep. Small conditions that only ` +
      'tweak wording stay INSIDE a step\'s instruction ("If nothing was found, say so ' +
      'briefly"); use a branch when the outcomes need DIFFERENT steps or tools. Never invent ' +
      'jump-to-step logic.',
    '- When the description repeats work per item ("for each ticket found, do X") or until ' +
      'a condition holds ("keep paging until nothing new"), use a LOOP object: {"kind": ' +
      '"loop", "name": short label, EITHER "over": the name of a saved LIST variable with ' +
      '"itemName": a short name for the current item (steps inside reference it as ' +
      '{{var:itemName}}) OR "until": the stop condition in plain words (checked AFTER each ' +
      `round; may use {{var:...}}, never {{tool:...}}), "maxIterations": 1-${MAX_LOOP_ITERATIONS} rounds, and ` +
      '"steps": the body. To carry results out of the loop, add "collectFrom": the saveAs ' +
      'name of a step INSIDE the body and "collectVar": a new list name — each round appends ' +
      'what that step saved, and later steps (or a later loop\'s "over") can use the list. ' +
      'Loops never contain other loops. Prefer ONE bulk tool call over a loop whenever a ' +
      'bulk tool covers the need — loops are for genuinely per-item reasoning or acting.',
    '- Only when the user NAMES a phase ("triage", "the cleanup part"), you may wrap steps ' +
      'in a GROUP object: {"kind": "group", "name": the phase name, "steps": [...]}. Groups ' +
      'change nothing about execution — never invent them.',
    '- When the user wants a HUMAN OK before a specific tool call fires ("ask me before ' +
      'sending", "wait for my approval before closing it"), set that step\'s "needsApproval": ' +
      'true and, if the description gives a wait, "approvalTimeoutHours" (default ' +
      `${APPROVAL_DEFAULT_TIMEOUT_HOURS}). The run PAUSES before the tool call for the owner; ` +
      'if they decline or the wait expires, the call is skipped and the automation continues. ' +
      'Only a step with a "tool" may carry it — never on a pure-reasoning step.',
    '- The description may also want the automation to ask the user something and use their ' +
      'reply ("ask which project", "let me pick the wording") rather than gate one tool call. ' +
      'That is not something to draft as a step: add a short entry to "questions" instead, so ' +
      'the user is asked in the builder up front, OR — when the need can only be known partway ' +
      'through the run — leave it out of the steps and add an "edgeCases" note that the ' +
      'automation may need to ask mid-run; the user enables that from the builder\'s "Can ask ' +
      'questions" toggle, which is separate from these drafted steps.',
    '- When the user wants to be NOTIFIED about how the flow ends ("email me if it fails", ' +
      '"send me a WebEx note when it\'s done"), or wants a branch path to deliberately end ' +
      'the whole run, use an END object as the LAST entry of that list: {"kind": "end", ' +
      '"name": short label, "result": "success" (finished as intended) | "failure" (a ' +
      'deliberate failure exit) | "stop" (nothing to do — graceful, silent), "message": what ' +
      'the notification should say (may use {{var:...}} for real context, never {{tool:...}}), ' +
      '"notify": array of "email" and/or "webex" (empty = no notification). Reaching an end ' +
      'object ends the WHOLE run — never put steps after one in the same list. Only add one ' +
      'when the description asks for a notification or an explicit ending.',
    '- Carry the user\'s guardrails into the step that acts (e.g. "if this thread was already ' +
      'handled, do not update the same ticket again — stop instead").',
    '- Think hard about the EDGE CASES of these rules before answering: what happens when the ' +
      'trigger fires with missing or odd data, a search finds nothing (or far too many), a ' +
      'tool call fails, the same item was already handled by an earlier run, or a condition ' +
      'is ambiguous between two paths. Handle the realistic ones IN the steps — empty-result ' +
      'wording in the instruction, a "failures" entry, a stop-quiet or end-marker exit — and ' +
      'note what you considered in "edgeCases" so the reasoning is checkable.',
    '- NEVER invent specifics the description does not give: project keys, board or folder ' +
      'names, email addresses, room names, thresholds, labels. When a step needs one, add a ' +
      'short question for the user to "questions" and write the step in plain words around ' +
      'the gap ("the project the user names") — a wrong guess acted on is worse than a ' +
      'question.',
    '- A step that FAILS stops the automation by default. To handle a specific failure of a ' +
      'tool step differently, add it to that step\'s "failures" array using one of the tool\'s ' +
      'listed failure codes: {"outcome": code, "action": "stop"} stops deliberately, ' +
      '{"outcome": code, "action": "retry", "guidance": "corrective instruction"} retries with ' +
      'that guidance, {"outcome": code, "action": "stop-quiet"} declares the condition NOT ' +
      'an error (e.g. "nothing found" can mean the automation does not apply) — the run ends ' +
      'silently and shows as skipped rather than failed — and {"outcome": code, "action": ' +
      '"continue"} notes the failure and moves on to the next step (the step\'s saved result ' +
      'becomes the failure summary). Guidance may use {{var:...}} and ' +
      '{{tool:...}} chips — guidance tools become available to the step ONLY on retries (the ' +
      'corrective set). Unlisted codes stop.',
    '- When the user\'s description implies retrying (e.g. "search again with different ' +
      'keywords"), express it as a "retry" failure handling with that guidance, and set "tries" ' +
      'to how many total attempts make sense (1-10, default 5). On a retry entry, ' +
      '"onExhausted" says what happens when every try fails: "stop" (default), "continue" ' +
      '(move on anyway), or "stop-quiet" (end silently).',
    "- When a SEARCH step's results feed a later decision or creation step, and the tool " +
      'lists a "no-results" code, prefer {"outcome": "no-results", "action": "retry", ' +
      '"guidance": "reword the search — broaden terms or try another identifier", ' +
      '"onExhausted": "continue"} so an empty first search is retried differently and a ' +
      'genuinely empty result still lets the automation decide what to do next.',
    '- When the description plans for a condition the tool does not list ("if the results ' +
      'are not close enough, reword and retry", "if the statement is for the wrong account, ' +
      'skip it"), add a CUSTOM condition: an invented short kebab-case "outcome" code plus a ' +
      '"when" sentence saying when it applies — e.g. {"outcome": "poor-match", "when": "results ' +
      'exist but none match the description closely enough", "action": "retry", "guidance": ' +
      '"reword the search using the description\'s own terms"}. The runner has the step model ' +
      'judge the "when" over the result, so it works even when the call technically succeeded.',
    ...(revising
      ? [
          '- Every returned step carries "from": the sN id of the existing step it is based on (kept or tweaked), or null for a brand-new step. Unchanged and tweaked steps MUST carry their id — it preserves the owner\'s retry settings.',
          '',
          'The automation currently has these steps:',
          currentLines,
        ]
      : []),
    '',
    'Available tools:',
    toolLines,
    '',
    "Available variables (trigger.* variables describe the event that starts the automation — pass the id-shaped ones to the matching connector tool to act on that item, e.g. reply where a message came from by giving its space/room id variable to that connector's send tool). Use ONLY these variable names. Never invent trigger.* names: if the described automation reacts to an event but no matching trigger.* variable is listed, write the step in plain words instead — the user must attach that trigger in the builder before its data exists:",
    varLines,
    ...(triggerOffer
      ? [
          '',
          'Triggers — WHEN the automation runs. Include a "triggers" array (at most 3 entries) ' +
            'ONLY when the description clearly states when it runs ("every weekday at 9", "when ' +
            'a message is posted", "when called from our script"). If it does not clearly state ' +
            'one, OMIT the field entirely — never invent or guess a trigger. Each entry is one of:',
          '  {"kind": "schedule", "rules": array of 1-' +
            `${MAX_SCHEDULE_RULES}, "timezone": IANA zone ONLY when the ` +
            'description names one, else null}. Each rule: {"every": "hour"} | {"every": "day", ' +
            '"at": "HH:MM"} | {"every": "weekday", "at": "HH:MM"} (weekday = Monday-Friday) | ' +
            '{"every": "week", "weekday": 0-6 (0 = Sunday), "at": "HH:MM"} | {"every": "month", ' +
            '"day": 1-31, "at": "HH:MM"}. Times are 24-hour.',
          '  {"kind": "event", "eventId": one of EXACTLY these ids, "match": OPTIONAL filters}:',
          ...TRIGGER_EVENT_CATALOG.flatMap((event) => [
            `    - ${event.id}: ${event.label} — ${event.description}`,
            ...event.filters.flatMap((field) => [
              `        match.${field.id}: ${
                field.input === 'select'
                  ? `EXACTLY one of ${(field.options ?? [])
                      .filter((option) => option.value)
                      .map((option) => `"${option.value}"`)
                      .join(' | ')}`
                  : field.input === 'text'
                    ? 'one string'
                    : 'a list of strings'
              } — ${field.label.toLowerCase()}. ${field.hint}`,
              // Taught explicitly rather than left to be guessed: the
              // default is the permissive one, so the only way to get ALL
              // wrong is to write it when the user did not ask for it.
              ...(field.modeKey
                ? [
                    `        match.${field.modeKey}: "all" ONLY when the description says every ` +
                      `one of them must appear ("mentions both X and Y"). Omit it otherwise — ` +
                      `any one of them matching is the default.`,
                  ]
                : []),
            ]),
          ]),
          // The filters are deterministic and cheap, so a stated one is
          // worth capturing — but an INVENTED one silently stops an agent
          // firing, and nothing downstream ever reports why. Guessing here
          // is strictly worse than omitting.
          '  Include "match" ONLY for a narrowing the description states outright ("emails from ' +
            'billing@acme.com", "messages in the #support space"). Never infer one from context, ' +
            'never guess an address or an id, and omit "match" entirely when in doubt. A filter ' +
            'the user did not ask for makes the automation silently never run.',
          ...(triggerOffer.otherAgents.length > 0
            ? [
                '  {"kind": "agent", "agentName": EXACTLY one of the user\'s other automations} — ' +
                  'runs after that automation finishes. Their names: ' +
                  triggerOffer.otherAgents.map((agent) => `"${agent.name}"`).join(', ') +
                  '.',
              ]
            : []),
          '  {"kind": "api", "inputs": array of {"name": short input name, "label": short ' +
            'label}} — an external caller starts the automation over the API, passing these ' +
            'inputs (they become trigger.<name> variables).',
        ]
      : []),
    '',
    revising ? 'The user asked for this change:' : 'The user wrote:',
    '"""',
    text,
    '"""',
    '',
    'Reply with ONLY a JSON object — no code fences, no commentary before or after — in',
    'exactly this structure:',
    '{',
    '  "name": string — a short agent name, at most 60 characters,',
    '  "edgeCases": OPTIONAL array of short strings — the edge cases you considered and how',
    '    the steps handle them (or why they need no handling),',
    '  "questions": OPTIONAL array of at most 5 short questions for the user — ONLY for',
    '    information the description leaves out that you must not guess; omit when none,',
    ...(offerGuardrails
      ? [
          '  "guardrails": OPTIONAL string — ONLY when the description states STANDING RULES',
          '    that apply to every run (e.g. "always draft, never send without approval",',
          '    "never invent numbers", sources of truth and their precedence, privacy rules),',
          '    collect them into one short plain-text document. Never restate the steps as',
          '    guardrails; omit when the description states none,',
        ]
      : []),
    ...(triggerOffer
      ? [
          '  "triggers": OPTIONAL array as described above — omit it unless the description',
          '    clearly states when the automation runs,',
        ]
      : []),
    `  "steps": array of 1 to ${maxSteps} objects, in execution order, each:`,
    '  {',
    '    "name": string — a short step label, at most 80 characters, never empty,',
    '    "instruction": string — the plain-words instruction with {{tool:...}} and',
    '      {{var:...}} tokens inline; never empty,',
    '    "tool": string or null — EXACTLY the tool_name inside the instruction\'s',
    '      {{tool:...}} token, or null for a reasoning step with no tool,',
    '    "saveAs": string or null — a short result name when later steps reference it',
    '      (starts with a letter; then letters, numbers, spaces, ".", "-" or "_";',
    '      at most 64 characters), otherwise null,',
    '    "tries": integer 1-10 or omitted — total attempts for this step (default 5),',
    '    "onSuccess": "continue" (default), "stop" (the automation ends here successfully),',
    '      or "stop-quiet" (ends silently: no reply, no follow-up automations),',
    '    "failures": array or omitted — only meaningful on tool steps; each entry:',
    '      { "outcome": one of the tool\'s failure codes — OR your own short kebab-case',
    '          code for a condition the tool does not enumerate, in which case "when" is',
    '          required,',
    '        "action": "stop", "retry", "stop-quiet" (not an error — end the run',
    '          silently), or "continue" (note the failure and move on to the next step),',
    '        "guidance": string — required when action is "retry" (what to do differently);',
    '          on any other action an OPTIONAL note the step model reads ("that is a valid',
    '          answer — record it and move on"); plain words, may use {{tool:...}} and',
    '          {{var:...}} tokens; or null,',
    '        "when": string or omitted — ONLY with an invented outcome code: one plain',
    '          sentence saying when the condition applies (e.g. "the results exist but',
    '          none match the description closely enough"). The step model judges it by',
    '          reasoning over the result, so a call that technically succeeded can still',
    '          match,',
    '        "onExhausted": "stop" (default), "continue", or "stop-quiet" — only with',
    '          action "retry": what happens when every try fails },',
    '    "needsApproval": boolean or omitted — ONLY on a step with a "tool": true pauses the',
    '      run before that tool call fires for the owner to approve or decline; declined or',
    '      timed out skips the call and the automation continues,',
    '    "approvalTimeoutHours": integer or omitted — only with "needsApproval": true, how',
    `      long to wait before treating it as not approved (default ${APPROVAL_DEFAULT_TIMEOUT_HOURS})` +
      (revising ? ',' : ''),
    ...(revising
      ? [
          '    "from": string or null — the sN id of the existing step this one is based',
          '      on, or null for a brand-new step',
        ]
      : []),
    '  }',
    '  A steps array entry may INSTEAD be a branch:',
    '  {',
    '    "kind": "branch",',
    '    "name": string — a short label for the decision, never empty,',
    '    "condition": string — the deciding question in plain words; {{var:...}} allowed,',
    '      {{tool:...}} forbidden,',
    `    "paths": array of 2 to ${MAX_BRANCH_PATHS} routes, in order, the LAST being the fallback;`,
    '      each { "label": string — short path name (e.g. "A ticket exists"),',
    '             "steps": array of steps (may be empty — an empty path just continues) }' +
      (revising ? ',' : ''),
    ...(revising ? ['    "from": string or null — the sN id of the existing branch, or null'] : []),
    '  }',
    '  Or a loop:',
    '  {',
    '    "kind": "loop",',
    '    "name": string — a short label, never empty,',
    '    "over": string or null — the name of a saved LIST variable to go through,',
    '    "itemName": string or null — required with "over": what to call the current item,',
    '    "until": string or null — INSTEAD of "over": the stop condition in plain words,',
    '      checked after each round; {{var:...}} allowed, {{tool:...}} forbidden,',
    `    "maxIterations": integer 1-${MAX_LOOP_ITERATIONS} — the round ceiling,`,
    '    "collectFrom": string or null — the saveAs name of a step INSIDE the body whose',
    '      result each round appends,',
    '    "collectVar": string or null — required with collectFrom: the new list\'s name,',
    '    "steps": array of steps — the body, never empty' + (revising ? ',' : ''),
    ...(revising ? ['    "from": string or null — the sN id of the existing loop, or null'] : []),
    '  }',
    '  Or a group (ONLY when the user names a phase):',
    '  {',
    '    "kind": "group",',
    '    "name": string — the phase name, never empty,',
    '    "steps": array of steps — never empty' + (revising ? ',' : ''),
    ...(revising ? ['    "from": string or null — the sN id of the existing group, or null'] : []),
    '  }',
    '  Or an end marker (ONLY when the description asks for a notification or an explicit ending):',
    '  {',
    '    "kind": "end",',
    '    "name": string — a short label for the ending, never empty,',
    '    "result": "success", "failure", or "stop",',
    '    "message": string or null — the notification text; {{var:...}} allowed,',
    '      {{tool:...}} forbidden,',
    '    "notify": array containing "email" and/or "webex", or empty' + (revising ? ',' : ''),
    ...(revising
      ? ['    "from": string or null — the sN id of the existing end marker, or null']
      : []),
    '  }',
    '}',
    'Every field must be present on every step. Do not add fields not listed here.',
  ].join('\n');
}

const TOKEN_PATTERN = /\{\{(tool|var):([^}]{1,128})\}\}/g;

/** Token string → segments, keeping only chips that verify. */
function segmentsOf(
  instruction: string,
  validTools: Set<string>,
  knownVars: Set<string>,
  // Guidance is the deliberately laxer corrective set — several tool chips
  // are legal there, where a step instruction takes at most one.
  allowMultipleTools = false
): InstructionSegment[] {
  const segments: InstructionSegment[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = segments[segments.length - 1];
    if (last && last.t === 'text') last.v += value;
    else segments.push({ t: 'text', v: value });
  };

  let cursor = 0;
  let toolPlaced = false;
  for (const match of instruction.matchAll(TOKEN_PATTERN)) {
    pushText(instruction.slice(cursor, match.index));
    cursor = (match.index ?? 0) + match[0].length;
    const [, kind, rawName] = match;
    const name = rawName.trim();
    if (kind === 'tool' && validTools.has(name) && (allowMultipleTools || !toolPlaced)) {
      segments.push({ t: 'tool', name });
      toolPlaced = true;
    } else if (kind === 'var' && knownVars.has(name)) {
      // trigger.* names get no free pass: a chip naming trigger data no
      // attached trigger provides would bounce at save ("not something this
      // agent knows"), so it degrades to text like any other unknown var.
      segments.push({ t: 'var', name });
    } else {
      // An invented tool, a duplicate tool chip, or an unknown variable:
      // keep the words, drop the chip — the builder shows text the user
      // can re-chip deliberately.
      pushText(name);
    }
  }
  pushText(instruction.slice(cursor));
  return segments;
}

/**
 * The retry feedback for a {{var:trigger.*}} chip nothing provides: name the
 * trigger variables that DO exist so the corrective round trip can pick one,
 * or say plainly that a trigger must be attached first.
 */
function unknownTriggerVarProblem(label: string, name: string, knownVars: Set<string>): string {
  const available = [...knownVars].filter((known) => known.startsWith('trigger.'));
  return (
    `${label} uses {{var:${name}}}, but no attached trigger provides it — ` +
    (available.length > 0
      ? `the available trigger variables are: ${available.join(', ')}.`
      : 'no trigger is attached, so no trigger.* variables exist; write the step in plain words (the user attaches the trigger in the builder).')
  );
}

/**
 * Coerce a model-authored saveAs into VARIABLE_NAME_PATTERN shape (letter
 * first; letters, numbers, spaces, ".", "-", "_"; ≤64 chars) so a draft can
 * never bounce at save on a result name. Returns '' when nothing survives.
 */
function sanitizeSaveAs(raw: string): string {
  let name = raw
    .trim()
    .replace(/[^A-Za-z0-9 _.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  name = name.replace(/^[^A-Za-z]+/, '');
  return name.slice(0, 64).trim();
}

export interface DraftedAgent {
  name: string;
  steps: AgentStepNode[];
  /**
   * Proposed triggers, present only when the caller asked for suggestions
   * (the builder has none yet) — possibly empty when the prose never says
   * when the automation runs, which is the honest answer, not a failure.
   */
  triggers?: TriggerDraft[];
  /**
   * Things the model needs the USER to decide — specifics the description
   * left out that it must not invent (which project, whose inbox, what
   * threshold). The builder shows these under the draft; the user answers
   * in the description box and drafts again.
   */
  questions?: string[];
  /**
   * Reviewer concerns still open after the gap-closing rounds (see
   * `refineWithReview`) — the same critic the save-time "Worth checking"
   * panel runs, surfaced BEFORE saving so the user is not surprised later.
   */
  concerns?: ReviewNote[];
  /**
   * Standing rules the model extracted from the prose ("draft only, never
   * send", "never invent numbers") — proposed only when the agent has no
   * guardrails yet; the builder fills its Guardrails panel with them for
   * the owner to review.
   */
  guardrails?: string;
}

/**
 * The reply's structural contract, as zod schemas — the same shapes the
 * prompt describes in words. Validated in two layers so one malformed step
 * does not void nine good ones: the envelope must hold, then each step is
 * checked individually and broken ones become per-step feedback.
 */
// The steps ceiling is the ORG'S `agentMaxSteps` setting, not a constant:
// the reply envelope was the last place that still said 20, and it bounced
// every revision of an agent the org's raised limit had allowed to grow
// past that. The envelope must accept whatever the save will.
const replyEnvelopeOf = (maxSteps: number) =>
  z.object({
    name: z.string().optional(),
    steps: z
      .array(z.unknown())
      .min(1, 'must contain at least one step')
      .max(maxSteps, `takes at most ${maxSteps} steps`),
    triggers: z.array(z.unknown()).max(3, 'takes at most 3 triggers').optional(),
    // Open decisions only the user can make; "edgeCases" (the model's own
    // edge-case notes) also arrives but is working material, not output —
    // zod strips it with every other undeclared key.
    questions: z.array(z.unknown()).max(8, 'takes at most 5 questions').optional(),
    // Proposed standing rules — honored only when the caller offered (the
    // agent has none yet); a volunteered one is ignored otherwise.
    guardrails: z.string().optional(),
  });

const STEP_SHAPE = z.object({
  name: z.string().optional(),
  instruction: z.string().trim().min(1, 'is required and must be a non-empty string'),
  tool: z.string().nullable().optional(),
  saveAs: z.string().nullable().optional(),
  from: z.string().nullable().optional(),
  tries: z.number().int().min(1).max(10).optional(),
  onSuccess: z.enum(['continue', 'stop', 'stop-quiet']).optional(),
  failures: z
    .array(
      z.object({
        outcome: z.string().min(1, 'must be a failure code'),
        action: z.enum(['stop', 'retry', 'stop-quiet', 'continue']),
        guidance: z.string().nullable().optional(),
        onExhausted: z.enum(['stop', 'continue', 'stop-quiet']).optional(),
        when: z.string().optional(),
      })
    )
    .optional(),
  needsApproval: z.boolean().optional(),
  approvalTimeoutHours: z.number().int().min(1).optional(),
});

/**
 * The branch wire shape. Its path arrays stay unknown[] here — each entry
 * is checked individually by the recursive parse, so one malformed nested
 * step degrades to feedback instead of voiding the whole branch. Both the
 * v3 `paths` array and the legacy `ifSteps`/`elseSteps` pair parse — older
 * fine-tuned habits die hard, and both mean the same two-path branch.
 */
const BRANCH_SHAPE = z.object({
  kind: z.literal('branch'),
  name: z.string().trim().min(1, 'is required and must be a non-empty string'),
  condition: z.string().trim().min(1, 'is required and must be a non-empty string'),
  paths: z
    .array(z.object({ label: z.string().optional(), steps: z.array(z.unknown()) }))
    .min(2, 'needs at least 2 paths')
    .max(MAX_BRANCH_PATHS, `takes at most ${MAX_BRANCH_PATHS} paths`)
    .optional(),
  ifLabel: z.string().optional(),
  elseLabel: z.string().optional(),
  ifSteps: z.array(z.unknown()).optional(),
  elseSteps: z.array(z.unknown()).optional(),
  from: z.string().nullable().optional(),
});

const LOOP_SHAPE = z.object({
  kind: z.literal('loop'),
  name: z.string().trim().min(1, 'is required and must be a non-empty string'),
  over: z.string().nullable().optional(),
  itemName: z.string().nullable().optional(),
  until: z.string().nullable().optional(),
  maxIterations: z.number().int().min(1).max(MAX_LOOP_ITERATIONS).optional(),
  collectFrom: z.string().nullable().optional(),
  collectVar: z.string().nullable().optional(),
  steps: z.array(z.unknown()).min(1, 'must contain at least one step'),
  from: z.string().nullable().optional(),
});

const GROUP_SHAPE = z.object({
  kind: z.literal('group'),
  name: z.string().trim().min(1, 'is required and must be a non-empty string'),
  steps: z.array(z.unknown()).min(1, 'must contain at least one step'),
  from: z.string().nullable().optional(),
});

const END_SHAPE = z.object({
  kind: z.literal('end'),
  name: z.string().trim().min(1, 'is required and must be a non-empty string'),
  result: z.enum(['success', 'failure', 'stop']),
  message: z.string().nullable().optional(),
  notify: z.array(z.enum(['email', 'webex'])).optional(),
  from: z.string().nullable().optional(),
});

/* ---------------- trigger wire shapes ------------------------------ */

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const SCHEDULE_RULE_SHAPE = z.object({
  every: z.enum(['hour', 'day', 'weekday', 'week', 'month']),
  at: z.string().nullable().optional(),
  weekday: z.number().int().min(0).max(6).nullable().optional(),
  day: z.number().int().min(1).max(31).nullable().optional(),
});

const SCHEDULE_TRIGGER_SHAPE = z.object({
  kind: z.literal('schedule'),
  rules: z.array(z.unknown()).min(1, 'needs at least one rule').max(MAX_SCHEDULE_RULES),
  timezone: z.string().nullable().optional(),
});

const EVENT_TRIGGER_SHAPE = z.object({
  kind: z.literal('event'),
  eventId: z.string().min(1, 'is required'),
  /**
   * Deterministic filters. Loosely typed here on purpose — the legal field
   * ids are catalog data that varies per event, so the shape gate is
   * structural and `normalizeMatchForEvent` does the real narrowing.
   */
  match: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
});

const AGENT_TRIGGER_SHAPE = z.object({
  kind: z.literal('agent'),
  agentName: z.string().min(1, 'is required'),
});

const API_TRIGGER_SHAPE = z.object({
  kind: z.literal('api'),
  inputs: z
    .array(z.object({ name: z.string().min(1), label: z.string().nullable().optional() }))
    .max(10),
});

function weekdayOf(value: number): Weekday | null {
  switch (value) {
    case 0:
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
      return value;
    default:
      return null;
  }
}

/** One schedule rule off the wire → a real Recurrence, or a diagnosis. */
function recurrenceOf(raw: unknown, label: string, state: ParseState): Recurrence | null {
  const checked = SCHEDULE_RULE_SHAPE.safeParse(raw);
  if (!checked.success) {
    state.softProblems.push(...zodProblems(`${label} schedule rule: `, checked.error));
    return null;
  }
  const rule = checked.data;
  if (rule.every === 'hour') return { every: 'hour' };
  const at = typeof rule.at === 'string' ? rule.at : '';
  if (!TIME_PATTERN.test(at)) {
    state.softProblems.push(
      `${label} has a "${rule.every}" schedule rule without a valid "at" — give the time as 24-hour "HH:MM".`
    );
    return null;
  }
  switch (rule.every) {
    case 'day':
      return { every: 'day', at };
    case 'weekday':
      return { every: 'weekday', at };
    case 'week': {
      const weekday = typeof rule.weekday === 'number' ? weekdayOf(rule.weekday) : null;
      if (weekday === null) {
        state.softProblems.push(
          `${label} has a weekly schedule rule without "weekday" (0-6, 0 = Sunday).`
        );
        return null;
      }
      return { every: 'week', weekday, at };
    }
    case 'month': {
      if (typeof rule.day !== 'number') {
        state.softProblems.push(`${label} has a monthly schedule rule without "day" (1-31).`);
        return null;
      }
      return { every: 'month', day: rule.day, at };
    }
  }
}

/**
 * Parse the reply's proposed triggers. Same philosophy as steps: a broken
 * entry degrades to quotable feedback and is dropped — an invented event id
 * or unknown agent name must never reach the builder as a chip the save
 * would bounce. An empty result is fine: "the prose never said when" is the
 * honest answer the prompt asked for.
 */
function parseTriggerEntries(
  entries: unknown[],
  state: ParseState,
  offer: TriggerOffer
): TriggerDraft[] {
  const drafts: TriggerDraft[] = [];
  for (const [index, entry] of entries.entries()) {
    const label = `Trigger ${index + 1}`;
    if (typeof entry !== 'object' || entry === null) {
      state.softProblems.push(`${label} is not an object.`);
      continue;
    }
    const candidate: { kind?: unknown } = entry;
    switch (candidate.kind) {
      case 'schedule': {
        const checked = SCHEDULE_TRIGGER_SHAPE.safeParse(entry);
        if (!checked.success) {
          state.softProblems.push(...zodProblems(`${label} (schedule): `, checked.error));
          break;
        }
        const recurrences = checked.data.rules.flatMap((raw) => {
          const rule = recurrenceOf(raw, label, state);
          return rule ? [rule] : [];
        });
        if (recurrences.length === 0) break;
        const given = typeof checked.data.timezone === 'string' ? checked.data.timezone : '';
        if (given && !isValidTimezone(given)) {
          state.softProblems.push(
            `${label} names the timezone "${given}", which is not a recognized IANA zone — it was dropped (the user's own timezone applies).`
          );
        }
        // '' = "the prose named none": the builder fills in the USER'S zone,
        // which this code cannot know.
        const timezone = given && isValidTimezone(given) ? given : '';
        drafts.push({ kind: 'schedule', recurrences, timezone });
        break;
      }
      case 'event': {
        const checked = EVENT_TRIGGER_SHAPE.safeParse(entry);
        if (!checked.success) {
          state.softProblems.push(...zodProblems(`${label} (event): `, checked.error));
          break;
        }
        if (!triggerEventById(checked.data.eventId)) {
          state.softProblems.push(
            `${label} uses the event id "${checked.data.eventId}", which is not in the list — the legal ids are: ${TRIGGER_EVENT_CATALOG.map((event) => event.id).join(', ')}.`
          );
          break;
        }
        // A filter the model got wrong is DROPPED, not fatal. Drafting is
        // advisory — the builder is where a trigger is finished — and
        // refusing the whole draft over a mistyped address would throw away
        // the steps too. The soft problem carries it into the next round.
        const eventId = checked.data.eventId;
        const filterProblems = validateMatchForEvent(eventId, checked.data.match);
        for (const problem of filterProblems) {
          state.softProblems.push(`${label}'s filter was dropped: ${problem}`);
        }
        const match =
          filterProblems.length > 0 ? {} : normalizeMatchForEvent(eventId, checked.data.match);
        // Omitted when empty rather than sent as {}: a draft should say only
        // what the prose said, and an empty match is indistinguishable from
        // no match to everything downstream anyway.
        drafts.push({
          kind: 'event',
          eventId,
          ...(Object.keys(match).length > 0 ? { match } : {}),
        });
        break;
      }
      case 'agent': {
        const checked = AGENT_TRIGGER_SHAPE.safeParse(entry);
        if (!checked.success) {
          state.softProblems.push(...zodProblems(`${label} (agent): `, checked.error));
          break;
        }
        const wanted = checked.data.agentName.trim().toLowerCase();
        const match = offer.otherAgents.find((agent) => agent.name.trim().toLowerCase() === wanted);
        if (!match) {
          state.softProblems.push(
            offer.otherAgents.length > 0
              ? `${label} names the automation "${checked.data.agentName}", which the user does not have — their automations are: ${offer.otherAgents.map((agent) => `"${agent.name}"`).join(', ')}.`
              : `${label} is an "agent" trigger, but the user has no other automations — drop it.`
          );
          break;
        }
        drafts.push({ kind: 'agent', callerAgentId: match.id });
        break;
      }
      case 'api': {
        const checked = API_TRIGGER_SHAPE.safeParse(entry);
        if (!checked.success) {
          state.softProblems.push(...zodProblems(`${label} (api): `, checked.error));
          break;
        }
        const seen = new Set<string>();
        const inputs = checked.data.inputs.flatMap((input) => {
          const name = sanitizeSaveAs(input.name);
          if (!name || seen.has(name.toLowerCase())) return [];
          seen.add(name.toLowerCase());
          return [
            {
              name,
              label:
                typeof input.label === 'string' && input.label.trim()
                  ? input.label.trim().slice(0, 80)
                  : name,
            },
          ];
        });
        drafts.push({ kind: 'api', inputs });
        break;
      }
      default:
        state.softProblems.push(
          `${label} has the kind ${JSON.stringify(candidate.kind)} — triggers are "schedule", "event", "agent", or "api".`
        );
    }
  }
  return drafts;
}

function wireKindOf(entry: unknown): 'branch' | 'loop' | 'group' | 'end' | 'action' {
  if (typeof entry === 'object' && entry !== null) {
    const candidate: { kind?: unknown } = entry;
    if (
      candidate.kind === 'branch' ||
      candidate.kind === 'loop' ||
      candidate.kind === 'group' ||
      candidate.kind === 'end'
    ) {
      return candidate.kind;
    }
  }
  return 'action';
}

/** zod issues → the quotable one-liners the retry feedback is built from. */
function zodProblems(prefix: string, error: z.ZodError): string[] {
  return error.issues.map(
    (issue) =>
      `${prefix}${issue.path.length > 0 ? `"${issue.path.join('.')}" ` : ''}${issue.message}`
  );
}

/**
 * Parse one model reply into steps, DIAGNOSING instead of shrugging: every
 * way the reply can be unusable produces a concrete, quotable problem
 * ("steps[3] "instruction" is required…", "step 2 uses {{tool:x}} which is
 * not in the list") — because those strings go back to the model verbatim
 * as the retry feedback, and "unusable answer" teaches it nothing.
 */
/** Shared mutable state for one reply's recursive parse. */
interface ParseState {
  problems: string[];
  softProblems: string[];
  knownVars: Set<string>;
  usedSaveAs: Set<string>;
  validTools: Set<string>;
  outcomesByTool: Map<string, Set<string>>;
  /** sN (pre-order over the CURRENT tree) → the existing node. */
  originByRef: Map<string, AgentStepNode>;
}

function originOf(state: ParseState, from: string | null | undefined): AgentStepNode | undefined {
  if (typeof from !== 'string') return undefined;
  return state.originByRef.get(from.trim());
}

function parseDraftReply(
  raw: string,
  currentSteps: AgentStepNode[],
  validTools: Set<string>,
  outcomesByTool: Map<string, Set<string>>,
  seedVars: Set<string>,
  triggerOffer: TriggerOffer | null,
  offerGuardrails: boolean,
  maxSteps: number
): { ok: true; draft: DraftedAgent; softProblems: string[] } | { ok: false; problems: string[] } {
  const cleaned = raw.replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { ok: false, problems: ['The reply contained no JSON object at all.'] };
  }

  let json: unknown;
  try {
    json = JSON.parse(cleaned.slice(start, end + 1));
  } catch (error) {
    return {
      ok: false,
      problems: [
        `The JSON could not be parsed: ${error instanceof Error ? error.message : 'syntax error'}.`,
      ],
    };
  }

  const envelope = replyEnvelopeOf(maxSteps).safeParse(json);
  if (!envelope.success) {
    return { ok: false, problems: zodProblems('The reply object: ', envelope.error) };
  }
  const parsed = envelope.data;

  const state: ParseState = {
    problems: [],
    softProblems: [],
    knownVars: new Set(seedVars),
    usedSaveAs: new Set<string>(),
    validTools,
    outcomesByTool,
    originByRef: new Map(
      walkSteps(currentSteps).map(({ node, ordinal }) => [`s${ordinal + 1}`, node])
    ),
  };

  const steps = parseNodeList(parsed.steps, 'Step', state, TOP_NESTING);
  // Triggers only when the caller offered — a reply volunteering them
  // anyway (or a revise with triggers already configured) is ignored.
  const triggers = triggerOffer
    ? parseTriggerEntries(parsed.triggers ?? [], state, triggerOffer)
    : null;
  // Open decisions the model asked the user about. Trusted as prose (they
  // are shown, never executed), just bounded.
  const questions = (parsed.questions ?? [])
    .flatMap((entry) => (typeof entry === 'string' && entry.trim() ? [entry.trim()] : []))
    .map((question) => question.slice(0, 300))
    .slice(0, 5);
  const { problems, softProblems } = state;

  if (steps.length === 0) {
    return {
      ok: false,
      problems: problems.length > 0 ? problems : ['No step had a usable instruction.'],
    };
  }
  // Some steps parsed, some did not: usable, but the broken ones are worth
  // a corrective round trip.
  softProblems.push(...problems);

  // A model that echoes the same origin twice would duplicate ids; keep the
  // first claim, regenerate the rest — across the whole tree, path ids
  // included.
  const seenIds = new Set<string>();
  const claimId = (id: string): string => {
    const fresh = seenIds.has(id) ? randomUUID() : id;
    seenIds.add(fresh);
    return fresh;
  };
  const dedupe = (nodes: AgentStepNode[]): void => {
    for (const node of nodes) {
      node.id = claimId(node.id);
      switch (node.kind) {
        case 'branch':
          for (const path of node.paths) {
            path.id = claimId(path.id);
            dedupe(path.steps);
          }
          if (node.failurePath) {
            node.failurePath.id = claimId(node.failurePath.id);
            dedupe(node.failurePath.steps);
          }
          break;
        case 'loop':
        case 'group':
          dedupe(node.steps);
          break;
        case 'terminal':
        case 'action':
        case undefined:
          break;
        default: {
          const unhandled: never = node;
          throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
        }
      }
    }
  };
  dedupe(steps);

  const proposedGuardrails =
    offerGuardrails && typeof parsed.guardrails === 'string' && parsed.guardrails.trim()
      ? parsed.guardrails.trim()
      : null;

  return {
    ok: true,
    draft: {
      name: typeof parsed.name === 'string' ? parsed.name.slice(0, 200) : '',
      steps,
      ...(triggers !== null ? { triggers } : {}),
      ...(questions.length > 0 ? { questions } : {}),
      ...(proposedGuardrails ? { guardrails: proposedGuardrails } : {}),
    },
    softProblems,
  };
}

/** Containment counters threaded through the recursive parse. */
interface WireNesting {
  branchDepth: number;
  containerDepth: number;
  inLoop: boolean;
}

const TOP_NESTING: WireNesting = { branchDepth: 0, containerDepth: 0, inLoop: false };

/** Parse a wire steps array — container entries recurse, broken ones diagnose. */
function parseNodeList(
  entries: unknown[],
  labelPrefix: string,
  state: ParseState,
  nesting: WireNesting
): AgentStepNode[] {
  const nodes: AgentStepNode[] = [];
  for (const [index, entry] of entries.entries()) {
    const label = `${labelPrefix} ${index + 1}`;
    switch (wireKindOf(entry)) {
      case 'branch': {
        const parsedBranch = parseBranchEntry(entry, label, state, nesting);
        if (parsedBranch) nodes.push(parsedBranch);
        break;
      }
      case 'loop': {
        const parsedLoop = parseLoopEntry(entry, label, state, nesting);
        if (parsedLoop) nodes.push(parsedLoop);
        break;
      }
      case 'group': {
        const parsedGroup = parseGroupEntry(entry, label, state, nesting);
        if (parsedGroup) nodes.push(parsedGroup);
        break;
      }
      case 'end': {
        const parsedEnd = parseEndEntry(entry, label, state);
        if (parsedEnd) nodes.push(parsedEnd);
        break;
      }
      case 'action': {
        const checked = STEP_SHAPE.safeParse(entry);
        if (!checked.success) {
          state.problems.push(...zodProblems(`${label}: `, checked.error));
          break;
        }
        nodes.push(parseActionEntry(checked.data, label, state));
        break;
      }
    }
  }
  return nodes;
}

/** Diagnose a plain-words condition's chips (branch or until-loop). */
function conditionSegments(
  condition: string,
  label: string,
  state: ParseState
): InstructionSegment[] {
  if (/\{\{tool:/.test(condition)) {
    state.softProblems.push(
      `${label} puts a {{tool:...}} token in a condition — do that work in a step before it and save the result; the tool token was dropped.`
    );
  }
  for (const match of condition.matchAll(TOKEN_PATTERN)) {
    const [, kind, rawName] = match;
    const name = rawName.trim();
    if (kind === 'var' && !state.knownVars.has(name)) {
      state.softProblems.push(
        name.startsWith('trigger.')
          ? unknownTriggerVarProblem(`${label} (condition)`, name, state.knownVars)
          : `${label} references {{var:${name}}} in its condition, which no earlier step saves and no trigger provides.`
      );
    }
  }
  // No tool chips in a condition ever — drop even valid ones.
  return segmentsOf(condition, new Set<string>(), state.knownVars);
}

/** Claim a model-authored bound name (itemName/collectVar) into the namespace. */
function claimBoundName(raw: string, label: string, what: string, state: ParseState): string {
  let name = sanitizeSaveAs(raw);
  if (name !== raw.trim()) {
    state.softProblems.push(
      `${label} names its ${what} "${raw}", which is not a usable name — start with a letter, then letters, numbers, spaces, ".", "-" or "_" (64 characters max).` +
        (name ? ` It was renamed to "${name}".` : ' The name was dropped.')
    );
  }
  if (name && state.usedSaveAs.has(name.toLowerCase())) {
    state.softProblems.push(
      `${label} reuses the name "${name}" for its ${what} — every bound name must be unique across steps.`
    );
    let suffix = 2;
    let candidate = `${name} ${suffix}`;
    while (state.usedSaveAs.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = `${name} ${suffix}`;
    }
    name = candidate.slice(0, 64);
  }
  if (name) {
    state.usedSaveAs.add(name.toLowerCase());
    state.knownVars.add(name);
  }
  return name;
}

function parseBranchEntry(
  entry: unknown,
  label: string,
  state: ParseState,
  nesting: WireNesting
): AgentStepNode | null {
  const checked = BRANCH_SHAPE.safeParse(entry);
  if (!checked.success) {
    state.problems.push(...zodProblems(`${label} (branch): `, checked.error));
    return null;
  }
  const wire = checked.data;

  const inner: WireNesting = {
    branchDepth: nesting.branchDepth + 1,
    containerDepth: nesting.containerDepth + 1,
    inLoop: nesting.inLoop,
  };
  if (inner.branchDepth > MAX_BRANCH_DEPTH_V3 || inner.containerDepth > MAX_CONTAINER_DEPTH) {
    state.softProblems.push(
      `${label} nests a branch deeper than the limit (${MAX_BRANCH_DEPTH_V3} branch levels, ${MAX_CONTAINER_DEPTH} container levels) — restructure with fewer nested conditions.`
    );
    return null;
  }

  // Either wire dialect: the v3 paths array, or the legacy if/else pair.
  const wirePaths: { label: string | undefined; steps: unknown[]; fallback: string }[] =
    wire.paths && wire.paths.length > 0
      ? wire.paths.map((path, index) => ({
          label: path.label,
          steps: path.steps,
          fallback: index === wire.paths!.length - 1 ? 'Otherwise' : `Path ${index + 1}`,
        }))
      : wire.ifSteps || wire.elseSteps
        ? [
            { label: wire.ifLabel, steps: wire.ifSteps ?? [], fallback: 'If so' },
            { label: wire.elseLabel, steps: wire.elseSteps ?? [], fallback: 'Otherwise' },
          ]
        : [];
  if (wirePaths.length < 2) {
    state.problems.push(`${label} (branch): needs a "paths" array of at least 2 routes.`);
    return null;
  }

  const condition = conditionSegments(wire.condition, label, state);

  const origin = originOf(state, wire.from);
  const branchOrigin = origin && isBranchStep(origin) ? origin : undefined;

  const paths: BranchPath[] = wirePaths.map((wirePath, index) => ({
    id: branchOrigin?.paths[index]?.id ?? randomUUID(),
    name: (wirePath.label ?? '').trim().slice(0, 80) || wirePath.fallback,
    steps: parseNodeList(wirePath.steps, `${label}.path${index + 1}`, state, inner),
  }));

  return {
    id: branchOrigin?.id ?? randomUUID(),
    kind: 'branch',
    name: wire.name.slice(0, 80),
    condition,
    paths,
    // The failure route is builder-authored, never drafted — a revision
    // that echoes this branch keeps the one the owner configured.
    ...(branchOrigin?.failurePath
      ? { failurePath: structuredClone(branchOrigin.failurePath) }
      : {}),
    maxAttempts: branchOrigin?.maxAttempts ?? 2,
  };
}

function parseLoopEntry(
  entry: unknown,
  label: string,
  state: ParseState,
  nesting: WireNesting
): AgentStepNode | null {
  const checked = LOOP_SHAPE.safeParse(entry);
  if (!checked.success) {
    state.problems.push(...zodProblems(`${label} (loop): `, checked.error));
    return null;
  }
  const wire = checked.data;

  if (nesting.inLoop) {
    state.softProblems.push(
      `${label} nests a loop inside a loop — loops never nest; restructure (e.g. collect results in the first loop and run a second one after it).`
    );
    return null;
  }
  const inner: WireNesting = {
    branchDepth: nesting.branchDepth,
    containerDepth: nesting.containerDepth + 1,
    inLoop: true,
  };
  if (inner.containerDepth > MAX_CONTAINER_DEPTH) {
    state.softProblems.push(
      `${label} nests a loop deeper than the container limit (${MAX_CONTAINER_DEPTH}) — move it up a level.`
    );
    return null;
  }

  const over = typeof wire.over === 'string' ? wire.over.trim() : '';
  const until = typeof wire.until === 'string' ? wire.until.trim() : '';
  if (!over && !until) {
    state.problems.push(
      `${label} (loop): needs either "over" (a saved list variable) or "until" (a stop condition).`
    );
    return null;
  }

  const origin = originOf(state, wire.from);
  const loopOrigin = origin && origin.kind === 'loop' ? origin : undefined;
  const maxIterations = wire.maxIterations ?? loopOrigin?.maxIterations ?? LOOP_DEFAULT_ITERATIONS;

  let head:
    | Pick<Extract<LoopStep, { mode: 'foreach' }>, 'mode' | 'itemsVar' | 'itemVar'>
    | Pick<Extract<LoopStep, { mode: 'until' }>, 'mode' | 'condition' | 'maxAttempts'>;
  if (over) {
    if (!state.knownVars.has(over)) {
      state.softProblems.push(
        `${label} loops over {{var:${over}}}, which no earlier step saves and no trigger provides — save the list first (or fix the name).`
      );
    }
    const itemVar =
      claimBoundName(
        typeof wire.itemName === 'string' && wire.itemName.trim() ? wire.itemName : 'item',
        label,
        'loop item',
        state
      ) || 'item';
    head = { mode: 'foreach', itemsVar: over, itemVar };
  } else {
    head = {
      mode: 'until',
      condition: conditionSegments(until, label, state),
      maxAttempts: loopOrigin?.mode === 'until' ? loopOrigin.maxAttempts : LOOP_DEFAULT_ATTEMPTS,
    };
  }

  const steps = parseNodeList(wire.steps, `${label}.body`, state, inner);
  if (steps.length === 0) {
    state.problems.push(`${label} (loop): its body had no usable steps.`);
    return null;
  }

  // Collect is both-or-neither, and the source must be saved INSIDE the body.
  const collectFrom = typeof wire.collectFrom === 'string' ? wire.collectFrom.trim() : '';
  const collectVarRaw = typeof wire.collectVar === 'string' ? wire.collectVar.trim() : '';
  let collect: { collectFrom: string; collectVar: string } | undefined;
  if (collectFrom || collectVarRaw) {
    const bodySaves = new Set(
      flattenActionSteps(steps).flatMap((step) => (step.saveAs ? [step.saveAs] : []))
    );
    if (!collectFrom || !collectVarRaw) {
      state.softProblems.push(
        `${label} sets only one of "collectFrom"/"collectVar" — both are needed; the collect was dropped.`
      );
    } else if (!bodySaves.has(collectFrom)) {
      state.softProblems.push(
        `${label} collects from "${collectFrom}", but no step INSIDE the loop saves that name — the collect was dropped.`
      );
    } else {
      const collectVar = claimBoundName(collectVarRaw, label, 'collected list', state);
      if (collectVar) collect = { collectFrom, collectVar };
    }
  }

  return {
    id: loopOrigin?.id ?? randomUUID(),
    kind: 'loop',
    name: wire.name.slice(0, 80),
    ...head,
    maxIterations,
    ...(collect ?? {}),
    steps,
  };
}

function parseGroupEntry(
  entry: unknown,
  label: string,
  state: ParseState,
  nesting: WireNesting
): GroupStep | null {
  const checked = GROUP_SHAPE.safeParse(entry);
  if (!checked.success) {
    state.problems.push(...zodProblems(`${label} (group): `, checked.error));
    return null;
  }
  const wire = checked.data;
  const origin = originOf(state, wire.from);
  const groupOrigin = origin && origin.kind === 'group' ? origin : undefined;
  // Groups are depth-neutral — same nesting inside.
  const steps = parseNodeList(wire.steps, `${label}.body`, state, nesting);
  if (steps.length === 0) {
    state.problems.push(`${label} (group): its body had no usable steps.`);
    return null;
  }
  return {
    id: groupOrigin?.id ?? randomUUID(),
    kind: 'group',
    name: wire.name.slice(0, 80),
    steps,
  };
}

function parseEndEntry(entry: unknown, label: string, state: ParseState): TerminalStep | null {
  const checked = END_SHAPE.safeParse(entry);
  if (!checked.success) {
    state.problems.push(...zodProblems(`${label} (end): `, checked.error));
    return null;
  }
  const wire = checked.data;
  const messageText = typeof wire.message === 'string' ? wire.message.trim() : '';
  for (const match of messageText.matchAll(TOKEN_PATTERN)) {
    const [, kind, rawName] = match;
    const name = rawName.trim();
    if (kind === 'var' && !state.knownVars.has(name)) {
      state.softProblems.push(
        name.startsWith('trigger.')
          ? unknownTriggerVarProblem(`${label} (end message)`, name, state.knownVars)
          : `${label} references {{var:${name}}} in its message, which no earlier step saves and no trigger provides.`
      );
    }
  }
  const notify = new Set(wire.notify ?? []);
  const origin = originOf(state, wire.from);
  const endOrigin = origin && origin.kind === 'terminal' ? origin : undefined;
  return {
    id: endOrigin?.id ?? randomUUID(),
    kind: 'terminal',
    name: wire.name.slice(0, 80),
    result: wire.result,
    // Tool chips never belong in an ending's message — drop even valid ones.
    message: segmentsOf(messageText, new Set<string>(), state.knownVars),
    notifyEmail: notify.has('email'),
    notifyWebex: notify.has('webex'),
  };
}

function parseActionEntry(
  step: z.infer<typeof STEP_SHAPE>,
  label: string,
  state: ParseState
): ActionStep {
  const { softProblems, knownVars, usedSaveAs, validTools, outcomesByTool } = state;

  // Unknown chips degrade to plain text, but they are also the retry
  // feedback that matters most: an invented tool name means the step
  // loses its skill entirely.
  for (const match of step.instruction.matchAll(TOKEN_PATTERN)) {
    const [, kind, rawName] = match;
    const name = rawName.trim();
    if (kind === 'tool' && !validTools.has(name)) {
      softProblems.push(
        `${label} uses {{tool:${name}}}, which is not in the available tools list — pick a tool from the list or make it a reasoning step.`
      );
    } else if (kind === 'var' && !knownVars.has(name)) {
      softProblems.push(
        name.startsWith('trigger.')
          ? unknownTriggerVarProblem(label, name, knownVars)
          : `${label} references {{var:${name}}}, which no earlier step saves and no trigger provides.`
      );
    }
  }
  if (
    typeof step.tool === 'string' &&
    step.tool &&
    !step.instruction.includes(`{{tool:${step.tool}}}`)
  ) {
    softProblems.push(
      `${label} sets "tool": "${step.tool}" but its instruction has no matching {{tool:${step.tool}}} token.`
    );
  }

  const segments = segmentsOf(step.instruction, validTools, knownVars);
  const tool = segments.find(
    (segment): segment is Extract<InstructionSegment, { t: 'tool' }> => segment.t === 'tool'
  );

  // "from": sN → the existing step this one is based on. Its identity,
  // attempt budget, and — when the tool didn't change — failure handling
  // survive the revision; the model only authors words and chips.
  const foundOrigin = originOf(state, step.from);
  const origin =
    foundOrigin && (foundOrigin.kind === undefined || foundOrigin.kind === 'action')
      ? foundOrigin
      : undefined;
  const sameTool = origin !== undefined && origin.tool === (tool?.name ?? null);

  let saveAs =
    typeof step.saveAs === 'string' && step.saveAs.trim() ? step.saveAs.trim() : origin?.saveAs;
  if (saveAs) {
    // Names that would bounce at save are coerced into shape here, with the
    // rule fed back so the corrective round trip learns it.
    const sanitized = sanitizeSaveAs(saveAs);
    if (sanitized !== saveAs) {
      softProblems.push(
        `${label} names its result "${saveAs}", which is not a usable name — start with a letter, then letters, numbers, spaces, ".", "-" or "_" (64 characters max).` +
          (sanitized ? ` It was renamed to "${sanitized}".` : ' The name was dropped.')
      );
      saveAs = sanitized || origin?.saveAs;
    }
  }
  if (saveAs) {
    // Result names must be unique across steps (the validator enforces
    // it at save); a duplicate is renamed so the draft stays usable and
    // the model is told what it did wrong.
    if (usedSaveAs.has(saveAs.toLowerCase())) {
      softProblems.push(
        `${label} reuses the result name "${saveAs}" — every saveAs must be unique across steps.`
      );
      let suffix = 2;
      let candidate = `${saveAs} ${suffix}`;
      while (usedSaveAs.has(candidate.toLowerCase())) {
        suffix += 1;
        candidate = `${saveAs} ${suffix}`;
      }
      saveAs = candidate.slice(0, 64);
    }
    usedSaveAs.add(saveAs.toLowerCase());
    knownVars.add(saveAs); // later steps may reference it
  }

  // Model-authored failure handling, checked against the tool's REAL
  // outcome codes so the validator never bounces what drafting produced.
  const authoredHandling: FailureHandling[] = [];
  if (step.failures && step.failures.length > 0) {
    if (!tool) {
      softProblems.push(
        `${label} has "failures" but no tool — failure handling belongs to tool steps.`
      );
    } else {
      const validCodes = outcomesByTool.get(tool.name) ?? new Set(['other']);
      const seenCodes = new Set<string>();
      for (const failure of step.failures) {
        if (seenCodes.has(failure.outcome)) continue;
        const whenText = typeof failure.when === 'string' ? failure.when.trim() : '';
        const enumerated = validCodes.has(failure.outcome);
        // A code the tool does not enumerate is legal WITH a "when"
        // description: it becomes a custom, model-reasoned condition, its
        // code re-derived by the same slugifier the builder uses. Without
        // one it stays a drop — an invented code nothing describes is a
        // chip the save would bounce.
        let outcome = failure.outcome;
        if (!enumerated && !whenText) {
          softProblems.push(
            `${label} handles "${failure.outcome}", which is not a failure code of ` +
              `${tool.name} — its codes are: ${[...validCodes].join(', ')}. To define it as ` +
              'a custom condition, add a "when" description saying when it applies.'
          );
          continue;
        }
        if (!enumerated) {
          outcome =
            customOutcomeSlug(failure.outcome) || customOutcomeSlug(whenText) || 'condition';
          if (seenCodes.has(outcome)) continue;
        }
        if (enumerated && whenText) {
          softProblems.push(
            `${label} puts a "when" description on "${failure.outcome}", which ${tool.name} ` +
              'already defines — the description was dropped.'
          );
        }
        seenCodes.add(outcome);
        const custom = !enumerated ? { when: whenText } : {};
        const guidanceText = typeof failure.guidance === 'string' ? failure.guidance.trim() : '';
        if (failure.action === 'retry' && !guidanceText) {
          softProblems.push(
            `${label} retries on "${outcome}" without guidance — guidance is ` +
              'required for retry, so it was changed to stop.'
          );
          authoredHandling.push({ outcome, action: 'exit', ...custom });
          continue;
        }
        // Non-retry prose is advisory — the note the step model reads on
        // attempt 1 — parsed with the same laxer multi-tool mode as
        // corrective guidance, and omitted entirely when empty.
        const prose = guidanceText
          ? { guidance: segmentsOf(guidanceText, validTools, knownVars, true) }
          : {};
        authoredHandling.push(
          failure.action === 'retry'
            ? {
                outcome,
                action: 'retry',
                guidance: segmentsOf(guidanceText, validTools, knownVars, true),
                // 'stop' is the wire word for the default; only a
                // deliberate departure is carried onto the handling.
                ...(failure.onExhausted && failure.onExhausted !== 'stop'
                  ? { exhausted: failure.onExhausted }
                  : {}),
                ...custom,
              }
            : failure.action === 'stop-quiet'
              ? { outcome, action: 'stop-quiet', ...prose, ...custom }
              : failure.action === 'continue'
                ? { outcome, action: 'continue', ...prose, ...custom }
                : { outcome, action: 'exit', ...prose, ...custom }
        );
      }
    }
  }

  // A gate is meaningless without a call to gate — dropped with a note
  // rather than handed to the save-time validator to reject outright.
  if (step.needsApproval && !tool) {
    softProblems.push(
      `${label} sets "needsApproval" but has no tool — a pause before a tool call needs a tool to gate; the gate was dropped.`
    );
  }
  const needsApproval = step.needsApproval === true && Boolean(tool);
  const keepOriginGate = step.needsApproval === undefined && sameTool && origin?.needsApproval;

  return {
    id: origin?.id ?? randomUUID(),
    name: typeof step.name === 'string' ? step.name.slice(0, 80) : (origin?.name ?? ''),
    instruction: segments,
    tool: tool?.name ?? null,
    maxAttempts: step.tries ?? origin?.maxAttempts ?? 5,
    // The model's explicit handling wins; absent that, a revision keeps
    // the origin's (failure conditions belong to a tool — a changed tool
    // starts clean).
    failureHandling:
      step.failures !== undefined ? authoredHandling : sameTool ? origin.failureHandling : [],
    ...(saveAs ? { saveAs } : {}),
    ...(step.onSuccess && step.onSuccess !== 'continue'
      ? { onSuccess: step.onSuccess }
      : step.onSuccess === undefined && origin?.onSuccess
        ? { onSuccess: origin.onSuccess }
        : {}),
    ...(needsApproval || keepOriginGate
      ? {
          needsApproval: true,
          approvalTimeoutHours:
            step.approvalTimeoutHours ??
            origin?.approvalTimeoutHours ??
            APPROVAL_DEFAULT_TIMEOUT_HOURS,
        }
      : {}),
  };
}

/**
 * Run the save-time critic (describe.ts's reviewer — the SAME rules the
 * "Worth checking" panel applies) against a draft that only exists in
 * memory. Null = the review itself failed or timed out, which silently
 * skips refinement: the critic is advisory here exactly as it is at save.
 */
async function reviewDraftConcerns(
  llm: ResolvedLlm,
  tenantId: string,
  draft: DraftedAgent,
  guardrails: string | null,
  budgetMs: number
): Promise<ReviewNote[] | null> {
  if (budgetMs < 10_000) return null;
  const stepsDoc: AgentStepsDoc = { version: CURRENT_STEPS_VERSION, steps: draft.steps };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outerMs = Math.min(REVIEW_TIMEOUT_MS, budgetMs);
  const completion = await Promise.race([
    llm.provider.complete({
      system:
        'You summarize user-drafted automations for the person who wrote them. You reply with strict JSON.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: buildAgentReviewPrompt(
                draft.name || 'Untitled automation',
                stepsDoc,
                draft.triggers ?? [],
                guardrails
              ),
            },
          ],
        },
      ],
      tools: [],
      maxTokens: Math.max(1_024, llm.maxOutputTokens),
      timeoutMs: Math.max(5_000, outerMs - 2_000),
    }),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), outerMs);
    }),
  ]).finally(() => clearTimeout(timer));
  if (completion === 'timeout' || !completion.ok) {
    logger.info('draft review skipped: {reason}', {
      component: 'agents/draft',
      tenantId,
      reason: completion === 'timeout' ? 'timeout' : completion.err.type,
    });
    return null;
  }
  const text = completion.val.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
  const parsed = parseAgentReviewReply(text);
  return parsed ? parsed.concerns : null;
}

/** The reviewer's findings, phrased as work for the drafting model. */
function refineFeedbackText(concerns: ReviewNote[]): string {
  return [
    'A careful reviewer read your drafted steps and flagged these gaps:',
    ...concerns
      .slice(0, 8)
      .map((note) => `- ${note.issue}${note.fix ? ` (suggested fix: ${note.fix})` : ''}`),
    '',
    'Revise the FULL step list to close every gap you can from the description alone — add ' +
      'the missing step, tighten the instruction, or handle the failure. When a gap needs ' +
      'information only the user has, do NOT guess or invent specifics: add a short question ' +
      'to "questions" instead and leave the affected step in plain words. Dismiss a concern ' +
      'only when the reviewer is wrong about how the steps run. Keep everything already ' +
      'correct (same instruction tokens, same saveAs names). Reply with ONLY the corrected ' +
      'JSON object, in exactly the structure described before.',
  ].join('\n');
}

/**
 * The gap-closing loop: review the draft with the save-time critic, hand
 * the concerns back to the drafting model, and repeat — bounded by rounds
 * and the shared time budget. Concerns still standing when the loop stops
 * ride out on the draft, so the builder shows them BEFORE the save that
 * would otherwise be the first time the user hears about them. Every
 * failure inside the loop degrades to "return the best draft so far";
 * refinement never turns a usable draft into an error.
 */
async function closeReviewGaps(context: {
  llm: ResolvedLlm;
  tenantId: string;
  deadline: number;
  /** The drafting conversation so far — refinement continues it. */
  messages: LlmMessage[];
  currentSteps: AgentStepNode[];
  validTools: Set<string>;
  outcomesByTool: Map<string, Set<string>>;
  seedVars: Set<string>;
  triggerOffer: TriggerOffer | null;
  /** The org's agentMaxSteps ceiling, already resolved by the caller. */
  maxSteps: number;
  /** The agent's existing guardrails; null = none configured. */
  guardrails: string | null;
  /** Whether the reply may propose guardrails (only when none exist). */
  offerGuardrails: boolean;
  draft: DraftedAgent;
  draftRaw: string;
}): Promise<DraftedAgent> {
  const { llm, tenantId, deadline, messages } = context;
  let current = context.draft;
  let currentRaw = context.draftRaw;
  // The critic judges against the EFFECTIVE rules: the configured ones, or
  // the ones this very draft proposed.
  const effectiveGuardrails = () => context.guardrails ?? current.guardrails ?? null;

  let concerns = await reviewDraftConcerns(
    llm,
    tenantId,
    current,
    effectiveGuardrails(),
    deadline - Date.now()
  );
  if (concerns === null) return current;

  for (let round = 1; concerns.length > 0 && round <= MAX_REFINE_ROUNDS; round += 1) {
    const remaining = deadline - Date.now();
    if (remaining < REFINE_MIN_BUDGET_MS) break;
    logger.info('draft refine round {round}: {count} concern(s)', {
      component: 'agents/draft',
      tenantId,
      round,
      count: concerns.length,
    });

    messages.push(
      { role: 'assistant', content: [{ type: 'text', text: currentRaw.slice(0, 8_000) }] },
      { role: 'user', content: [{ type: 'text', text: refineFeedbackText(concerns) }] }
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completion = await Promise.race([
      llm.provider.complete({
        system: DRAFT_SYSTEM,
        messages,
        tools: [],
        maxTokens: Math.max(MAX_OUTPUT_TOKENS, llm.maxOutputTokens),
        timeoutMs: Math.max(10_000, remaining - 5_000),
      }),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), remaining);
      }),
    ]).finally(() => clearTimeout(timer));
    if (completion === 'timeout' || !completion.ok) break;

    const raw = completion.val.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    const parsed = parseDraftReply(
      raw,
      context.currentSteps,
      context.validTools,
      context.outcomesByTool,
      context.seedVars,
      context.triggerOffer,
      context.offerGuardrails,
      context.maxSteps
    );
    // A refinement that regresses to unparseable loses; the pre-refine
    // draft (with its concerns attached) beats an error.
    if (!parsed.ok) break;
    current = parsed.draft;
    currentRaw = raw;

    const next = await reviewDraftConcerns(
      llm,
      tenantId,
      current,
      effectiveGuardrails(),
      deadline - Date.now()
    );
    // Review broke mid-loop: the refined draft stands, with the previous
    // round's concerns as the honest "still to check" list.
    if (next === null) break;
    concerns = next;
  }

  return concerns.length > 0 ? { ...current, concerns } : current;
}

export async function draftAgentFromProse(
  db: Kysely<DB>,
  tenantId: string,
  text: string,
  tools: ToolDescriptor[],
  options: {
    /** Present when revising: the builder's CURRENT (possibly unsaved) steps. */
    currentSteps?: AgentStepNode[];
    /** trigger.* variables the attached triggers provide (name + what it
     * is), so those chips verify and the prompt can explain them. */
    triggerVars?: TriggerVarInfo[];
    /**
     * Ask the model to propose triggers from the prose — set only when the
     * builder has none configured. The prompt forbids inventing one: prose
     * that never says when the automation runs yields no triggers.
     */
    suggestTriggers?: boolean;
    /** The caller's other agents, offered as agent-finished trigger targets. */
    otherAgents?: AgentOption[];
    /**
     * The agent's existing guardrails: drafted steps must respect them,
     * and the critic judges against them. When absent, the reply may
     * PROPOSE guardrails extracted from the prose.
     */
    guardrails?: string | null;
    /**
     * Run the gap-closing loop on a usable draft: review it with the
     * save-time critic and hand concerns back to the drafting model until
     * they close, the rounds run out, or the budget does. Off by default —
     * the extra model calls are the caller's latency decision.
     */
    refineWithReview?: boolean;
  } = {}
): Promise<DraftedAgent | { error: string; detail?: string }> {
  const currentSteps = options.currentSteps ?? [];
  const triggerVars = options.triggerVars ?? [];
  const triggerOffer: TriggerOffer | null = options.suggestTriggers
    ? { otherAgents: options.otherAgents ?? [] }
    : null;
  const guardrails = options.guardrails?.trim() || null;
  // Guardrails proposals only fill an empty slot — the draft never
  // rewrites rules the owner already wrote (same posture as triggers).
  const offerGuardrails = guardrails === null;
  const llmResult = await resolveAgentLlm(db, tenantId, null);
  if (!llmResult.ok) {
    return { error: 'No model is configured for this organization yet.' };
  }
  const llm = llmResult.val;

  // The org's step ceiling, the same one the save enforces (save.ts) —
  // drafting must offer and accept exactly what saving will, or a raised
  // limit lets an agent grow past 20 steps and then no revision of it can
  // ever parse.
  const settings = await getOrgSettings(tenantId);
  const maxSteps = Math.max(1, settings.ok ? settings.val.agentMaxSteps : MAX_STEPS);

  const validTools = new Set(tools.filter((tool) => !tool.appOnly).map((tool) => tool.name));
  const outcomesByTool = new Map(
    tools.map((tool) => [
      tool.name,
      new Set([...tool.outcomes.failures.map((failure) => failure.code), 'other']),
    ])
  );
  const seedVars = new Set([
    ...BUILTIN_VARIABLES.map((variable) => variable.name),
    ...triggerVars.map((variable) => variable.name),
    // Existing saveAs names stay referenceable even before their step is
    // re-emitted (the model may reorder).
    ...flattenActionSteps(currentSteps).flatMap((step) => (step.saveAs ? [step.saveAs] : [])),
  ]);

  // One corrective round trip: a failed parse (or a draft with invented
  // chips) goes back to the model WITH the concrete problems, because
  // "unusable answer — try again" teaches the human nothing and the model
  // less. The five-minute budget is shared across both calls.
  const deadline = Date.now() + DRAFT_TIMEOUT_MS;
  // What this call actually cost, so "drafting is slow" is a number rather
  // than a feeling: sequential model calls are the whole latency story here,
  // and the tool catalog is the bulk of every prompt.
  const startedAt = Date.now();
  let modelCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const reportTiming = (result: string) => {
    logger.info('prose draft {result}: {calls} call(s) in {ms}ms', {
      component: 'agents/draft',
      tenantId,
      result,
      calls: modelCalls,
      ms: Date.now() - startedAt,
      inputTokens,
      outputTokens,
      toolCount: tools.length,
      revising: currentSteps.length > 0,
    });
  };
  const messages: LlmMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: promptOf(
            text.slice(0, MAX_PROSE_CHARS),
            tools,
            currentSteps,
            triggerVars,
            triggerOffer,
            guardrails,
            offerGuardrails,
            maxSteps
          ),
        },
      ],
    },
  ];
  let lastProblems: string[] = [];
  // A first draft that parsed but had soft problems is kept: if the
  // corrective attempt REGRESSES (hard-fails or times out of budget), the
  // degraded-but-usable version beats an error. Its raw reply rides along
  // so the gap-closing loop can continue the conversation from it.
  let usable: DraftedAgent | null = null;
  let usableRaw = '';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining < 15_000) break; // not enough budget for a useful call

    let timer: ReturnType<typeof setTimeout> | undefined;
    const completion = await Promise.race([
      llm.provider.complete({
        system: DRAFT_SYSTEM,
        messages,
        tools: [],
        // The model config's own ceiling when it is higher: reasoning
        // deployments spend completion tokens on thinking first, and 4096
        // can be ALL reasoning with no JSON left.
        maxTokens: Math.max(MAX_OUTPUT_TOKENS, llm.maxOutputTokens),
        // Just under the outer race so the HTTP call, not the race, decides.
        timeoutMs: Math.max(10_000, remaining - 5_000),
      }),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), remaining);
      }),
    ]).finally(() => clearTimeout(timer));
    if (completion === 'timeout') {
      reportTiming('timed out');
      return {
        error:
          'The model took over five minutes and was cut off — try again, or try a shorter description.',
      };
    }
    modelCalls += 1;
    if (completion.ok) {
      inputTokens += completion.val.usage.inputTokens;
      outputTokens += completion.val.usage.outputTokens;
    }
    if (!completion.ok) {
      logger.warn('prose draft failed: {kind} {message}', {
        component: 'agents/draft',
        tenantId,
        kind: completion.err.type,
        message: completion.err.message?.slice(0, 300) ?? '',
      });
      // The kind decides what the user can actually DO about it — a bare
      // "could not draft steps" hides whether to retry, wait, or go fix
      // the model configuration.
      const kind = completion.err.type;
      // The adapter's redacted request summary (field names and sizes,
      // never content) — shown to the person who clicked Draft, so "wrong
      // payload" is diagnosable from the builder itself.
      const detail = typeof completion.err.cause === 'string' ? completion.err.cause : undefined;
      if (kind === 'auth') {
        return {
          error:
            'The model rejected the organization’s API key — an admin can check it under Agent models.',
        };
      }
      if (kind === 'rate_limit' || kind === 'overloaded') {
        return { error: 'The model is rate-limiting right now — try again in a minute.' };
      }
      if (kind === 'timeout' || kind === 'network') {
        return {
          error: 'The model did not answer in time — try again, or try a shorter description.',
        };
      }
      if (kind === 'invalid_request') {
        return {
          error: `The model rejected the request${completion.err.message ? `: ${completion.err.message.slice(0, 500)}` : ''} — an admin can check the model configuration under Agent models.`,
          ...(detail ? { detail } : {}),
        };
      }
      return {
        error: `The model failed (${kind}) — try again or write the steps by hand.`,
        ...(detail ? { detail } : {}),
      };
    }

    const raw = completion.val.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    const parsed = parseDraftReply(
      raw,
      currentSteps,
      validTools,
      outcomesByTool,
      seedVars,
      triggerOffer,
      offerGuardrails,
      maxSteps
    );

    if (parsed.ok) {
      usable = parsed.draft;
      usableRaw = raw;
      if (parsed.softProblems.length === 0 || attempt === 2) {
        // Good — or as good as one correction gets; chips that still don't
        // verify degrade to text for the user to re-chip deliberately.
        break;
      }
    }

    const problems = parsed.ok ? parsed.softProblems : parsed.problems;
    lastProblems = problems;
    logger.info('prose draft retry: {count} problem(s)', {
      component: 'agents/draft',
      tenantId,
      count: problems.length,
    });
    messages.push(
      { role: 'assistant', content: [{ type: 'text', text: raw.slice(0, 8_000) }] },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              'Your reply could not be used as-is. Problems:',
              ...problems.slice(0, 12).map((problem) => `- ${problem}`),
              '',
              'Reply again with ONLY the corrected JSON object, in exactly the structure ' +
                'described before. Fix every problem listed; keep everything that was already correct.',
            ].join('\n'),
          },
        ],
      }
    );
  }

  if (usable) {
    reportTiming('ok');
    if (!options.refineWithReview) return usable;
    return closeReviewGaps({
      llm,
      tenantId,
      deadline,
      messages,
      currentSteps,
      validTools,
      outcomesByTool,
      seedVars,
      triggerOffer,
      maxSteps,
      guardrails,
      offerGuardrails,
      draft: usable,
      draftRaw: usableRaw,
    });
  }

  reportTiming('unusable');
  logger.warn('prose draft unusable after retry: {problems}', {
    component: 'agents/draft',
    tenantId,
    problems: lastProblems.slice(0, 5).join(' | '),
  });
  return {
    error:
      lastProblems.length > 0
        ? `The model could not produce usable steps (${lastProblems[0]}) — try again or rephrase.`
        : 'The model gave an unusable answer — try again.',
  };
}
