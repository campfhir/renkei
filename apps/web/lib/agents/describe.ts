/**
 * The generated agent description: a save-time LLM pass that summarizes
 * the recipe in the owner's language and flags logic smells, so the review
 * panel can say "here's what this agent does — check it".
 *
 * ADVISORY, NEVER BLOCKING. Any failure — no model configured, timeout,
 * malformed reply — records description_status='failed' and the save has
 * already succeeded. Authoring an agent must not depend on the org's model
 * being reachable at that moment.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  describeFailureHandling,
  describeSchedule,
  instructionPreview,
  walkSteps,
  type ActionStep,
  type AgentStepNode,
  type AgentStepsDoc,
  type TriggerDraft,
} from '@renkei/agents';
import { resolveAgentLlm } from '@renkei/agent-llm';
import { logger } from '@/lib/logger';
import { saveDescription } from '@/lib/agents/store';
import { parseReviewNotes, type ReviewNote } from '@/lib/agents/notes';
import {
  retryWithBackoff,
  RetryExhaustedError,
  OperationAbortedError,
} from '@/lib/retry-with-backoff';

const GENERATION_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const MAX_OUTPUT_TOKENS = 1_024;
const MAX_RETRIES = 2; // 3 total attempts (initial + 2 retries)
const RETRY_BACKOFF_OFFSET_MS = 2000; // Start with 2 second delay

function describeTrigger(draft: TriggerDraft): string {
  switch (draft.kind) {
    case 'event':
      return `when the event "${draft.eventId}" happens`;
    case 'schedule':
      // Prose, not JSON: the description is read by the owner (and the
      // reviewing model), and the shared humanizer keeps every surface's
      // wording identical.
      return `on a schedule (${describeSchedule(draft)})`;
    case 'agent':
      return 'after another agent finishes';
    case 'api':
      return 'when called over the API';
  }
}

function actionStepLines(step: ActionStep, label: string, indent: string): string {
  // The shared reading, so the reviewer's outline can never lie about a
  // handling (the old inline ternary rendered 'continue' and 'stop-quiet'
  // both as "stop").
  const failure = step.failureHandling
    .map((handling) => describeFailureHandling(handling, step.maxAttempts, step.saveAs))
    .join('; ');
  return [
    `${indent}${label} ${step.name}`,
    `${indent}   does: ${instructionPreview(step.instruction)}`,
    step.tool ? `${indent}   tool: ${step.tool}` : `${indent}   tool: none (reasoning only)`,
    step.saveAs ? `${indent}   saves result as: ${step.saveAs}` : null,
    // Without this line the reviewer flags "nothing ends the run" on
    // agents that DO end deliberately.
    step.onSuccess === 'stop'
      ? `${indent}   on success: the whole automation ends here`
      : step.onSuccess === 'stop-quiet'
        ? `${indent}   on success: the automation ends here silently (no reply, no follow-up)`
        : null,
    failure
      ? `${indent}   failure handling: ${failure}`
      : `${indent}   failure handling: stop on any failure`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/**
 * Labels come from the SAME pre-order ordinals the builder canvas, the
 * outline, and the run timeline render — never a positional `5.1.2.`
 * scheme of this prompt's own. The concerns this prompt produces name
 * steps by number, and a number the owner cannot find on their canvas
 * points the fix at the wrong step.
 */
function nodeLines(
  nodes: AgentStepNode[],
  ordinals: ReadonlyMap<string, number>,
  indent: string
): string {
  return nodes
    .map((node) => {
      const label = `Step ${(ordinals.get(node.id) ?? 0) + 1}:`;
      switch (node.kind) {
        case 'action':
        case undefined: {
          const base = actionStepLines(node, label, indent);
          if (!node.needsApproval) return base;
          const recovery = node.onNotApproved;
          const recoveryBody = recovery
            ? recovery.steps.length
              ? nodeLines(recovery.steps, ordinals, `${indent}      `)
              : `${indent}      (nothing — continues below the step)`
            : `${indent}      (nothing — continues below the step)`;
          return [
            base,
            `${indent}   needs approval: the run PAUSES before this tool call and waits for the OWNER, up to ${node.approvalTimeoutHours ?? 96} hours`,
            `${indent}   if not approved (denied or timed out)${recovery ? `, path "${recovery.name}"` : ''}:\n${recoveryBody}`,
            `${indent}   after the recovery path finishes, the automation continues below the step`,
          ].join('\n');
        }
        case 'branch': {
          const pathBlock = (path: (typeof node.paths)[number], heading: string) => {
            const body = path.steps.length
              ? nodeLines(path.steps, ordinals, `${indent}      `)
              : `${indent}      (nothing — continues after the branch)`;
            return `${indent}   ${heading} "${path.name}":\n${body}`;
          };
          const twoWay = node.paths.length === 2;
          return [
            `${indent}${label} ${node.name} (a branch)`,
            `${indent}   decides: ${instructionPreview(node.condition)}`,
            ...node.paths.map((path, index) =>
              pathBlock(
                path,
                twoWay
                  ? index === 0
                    ? 'if yes, path'
                    : 'otherwise, path'
                  : index === node.paths.length - 1
                    ? `otherwise (the fallback), path`
                    : `path ${index + 1} of ${node.paths.length},`
              )
            ),
            ...(node.failurePath
              ? [
                  pathBlock(
                    node.failurePath,
                    'if the DECISION ITSELF keeps failing (never chosen by the agent), failure route'
                  ),
                ]
              : []),
            `${indent}   after a path finishes, the automation continues below the branch`,
          ].join('\n');
        }
        case 'loop': {
          const heading =
            node.mode === 'foreach'
              ? `${indent}   repeats its steps once per item of [${node.itemsVar}] (the current item is [${node.itemVar}]), at most ${node.maxIterations} rounds`
              : `${indent}   repeats its steps until: ${instructionPreview(node.condition)} (checked after each round; at most ${node.maxIterations} rounds — if still untrue then, the run fails)`;
          return [
            `${indent}${label} ${node.name} (a loop)`,
            heading,
            node.collectVar
              ? `${indent}   each round, what "${node.collectFrom}" saved is added to the list [${node.collectVar}] — rounds that save nothing add nothing`
              : null,
            nodeLines(node.steps, ordinals, `${indent}      `),
          ]
            .filter((line): line is string => line !== null)
            .join('\n');
        }
        case 'group':
          return [
            `${indent}${label} ${node.name} (a group — organizes the steps below; changes nothing about execution)`,
            nodeLines(node.steps, ordinals, `${indent}      `),
          ].join('\n');
        case 'terminal': {
          const wording =
            node.result === 'failure'
              ? 'the whole run ends here AS A FAILURE (a deliberate failure exit)'
              : node.result === 'stop'
                ? 'the whole run ends here gracefully as skipped'
                : 'the whole run finishes successfully here';
          const channels = [
            ...(node.notifyEmail ? ['an email to the owner'] : []),
            ...(node.notifyWebex ? ['a WebEx note to the owner'] : []),
          ];
          return [
            `${indent}${label} ${node.name} (an end marker) — when reached, ${wording}`,
            channels.length > 0
              ? `${indent}   sends ${channels.join(' and ')} with: ${instructionPreview(node.message)}`
              : `${indent}   sends no notification`,
          ].join('\n');
        }
        default: {
          const unhandled: never = node;
          throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
        }
      }
    })
    .join('\n');
}

/**
 * The whole steps document as the reviewer's plain-text outline — exported
 * so the agents-over-MCP tools can show a definition without inventing a
 * THIRD renderer. Same pre-order numbering as the canvas and timeline.
 */
export function renderStepsOutline(steps: AgentStepsDoc): string {
  const ordinals = new Map(walkSteps(steps.steps).map((entry) => [entry.node.id, entry.ordinal]));
  return nodeLines(steps.steps, ordinals, '');
}

/**
 * The reviewer prompt, exported so prose drafting can run the SAME critic
 * against a draft before the user ever sees it — the gap-closing loop and
 * the save-time "Worth checking" panel must judge by one set of rules, or
 * drafting would polish away concerns the panel then re-raises (or miss
 * ones it never checks).
 */
export function buildAgentReviewPrompt(
  name: string,
  steps: AgentStepsDoc,
  triggers: TriggerDraft[],
  guardrails?: string | null
): string {
  const ordinals = new Map(walkSteps(steps.steps).map((entry) => [entry.node.id, entry.ordinal]));
  const stepLines = nodeLines(steps.steps, ordinals, '');
  const triggerLines =
    triggers.length > 0
      ? triggers.map(describeTrigger).join('; ')
      : 'not yet triggered by anything';

  return [
    `An end user drafted this automation, named "${name}". It runs ${triggerLines}.`,
    '',
    ...(guardrails?.trim()
      ? [
          'The owner wrote these STANDING GUARDRAILS — every step must obey them at run time, and a step that plainly conflicts with them is a top-priority concern:',
          guardrails.trim(),
          '',
        ]
      : []),
    'Steps (variables appear as [name], tools as [tool_name]):',
    stepLines,
    '',
    'How the engine behaves — take this as given, and never raise a concern the engine already prevents:',
    '- Steps run in document order. Inside a branch, exactly ONE path runs (the engine forces a choice; the last path is the fallback). A loop repeats its body up to its stated round limit; a for-each loop over an empty list simply skips. After a branch or loop finishes, execution continues below it.',
    '- A later step runs ONLY if everything before it on its route succeeded.',
    '- A failure handled with "stop", an unhandled failure, or exhausted retries STOPS the whole automation immediately — later steps never run, so they can safely assume earlier steps succeeded. The exceptions are explicit: a failure handled with "continue" (or a retry whose after-every-try choice is "continue") records the failure and moves on, binding the step\'s saved result to the failure summary. Missing "fallbacks" for exhausted retries are not a flaw. A branch\'s failure route (when present) already covers the decision itself erroring.',
    "- The runner checks each step's tool is available before running, and verifies tool errors against the declared success.",
    '- Loop round limits and the collected-list size are engine-enforced ceilings with truncation notes — do not flag them as missing safeguards.',
    '- An end marker ends the WHOLE run exactly as configured (success, failure, or a graceful skip) and delivers only its own configured notifications — the editor already prevents steps after it, and a failure ending without notifications is a deliberate choice, not a flaw.',
    '- A step marked "needs approval" pauses safely before its tool call for the owner (every wait has an engine-enforced ceiling): approved fires the call, denied or timed out takes the recovery path (or, with none, just continues). Do not flag the pause, the wait, or an empty recovery path as problems.',
    '',
    'Reply with JSON only, no code fences: {"summary": "...", "concerns": [{"issue": "...", "fix": "..."}]}.',
    'summary: 2-3 plain sentences telling the OWNER what this agent does, no technical terms, no tool identifiers.',
    'concerns: 0-5 REAL logic problems a reviewer should check: an instruction promising work no step or tool performs, a step needing information nothing provides, contradictory failure handling, a saved result nothing uses, or a step that conflicts with the standing guardrails above (e.g. a sending step under a "draft only" rule). Each carries "issue" (what is wrong, one sentence) and "fix" (the concrete edit the owner should make, one sentence, e.g. which step to add or how to reword an instruction). Empty array if none.',
    'When naming a step, use its number EXACTLY as labeled above ("Step 7") — the owner sees these same numbers in the editor. Never invent dotted numbering like "Step 5.1.2".',
  ].join('\n');
}

export function parseAgentReviewReply(
  text: string
): { summary: string; concerns: ReviewNote[] } | null {
  // Models fence JSON despite instructions; strip fences before parsing.
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: { summary?: unknown; concerns?: unknown } = JSON.parse(
      cleaned.slice(start, end + 1)
    );
    if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) return null;
    return { summary: parsed.summary.trim(), concerns: parseReviewNotes(parsed.concerns) };
  } catch {
    return null;
  }
}

/**
 * Generate and persist the description for a just-saved agent. Returns
 * what it stored so the save route can include it in the response.
 */
export async function generateAgentDescription(
  db: Kysely<DB>,
  tenantId: string,
  agent: {
    id: string;
    name: string;
    steps: AgentStepsDoc;
    triggers: TriggerDraft[];
    llmModelId: string | null;
    guardrails?: string | null;
  }
): Promise<{ description: string | null; reviewNotes: ReviewNote[] }> {
  const failed = async (reason: string) => {
    logger.debug('agent description generation skipped: {reason}', {
      component: 'agents/describe',
      tenantId,
      agentId: agent.id,
      reason,
    });
    await saveDescription(db, tenantId, agent.id, { status: 'failed' });
    return { description: null, reviewNotes: [] };
  };

  const llmResult = await resolveAgentLlm(db, tenantId, agent.llmModelId);
  if (!llmResult.ok) return failed(llmResult.err.type);
  const llm = llmResult.val;

  try {
    const completion = await retryWithBackoff(
      () =>
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
                    agent.name,
                    agent.steps,
                    agent.triggers,
                    agent.guardrails
                  ),
                },
              ],
            },
          ],
          tools: [],
          maxTokens: Math.max(MAX_OUTPUT_TOKENS, llm.maxOutputTokens),
        }),
      {
        timeout: GENERATION_TIMEOUT_MS,
        maxRetries: MAX_RETRIES,
        backoffStrategy: 'exponential',
        backoffOffset: RETRY_BACKOFF_OFFSET_MS,
        onRetry: (attempt, error, nextDelayMs) => {
          logger.debug(
            'agent description generation retry {attempt}: {error} (waiting {delay}ms before retry)',
            {
              component: 'agents/describe',
              tenantId,
              agentId: agent.id,
              attempt,
              error: error.message,
              delay: nextDelayMs,
            }
          );
        },
      }
    );

    if (!completion.ok) {
      return failed(
        `${completion.err.type}${completion.err.message ? `: ${completion.err.message.slice(0, 300)}` : ''}`
      );
    }

    const text = completion.val.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    const parsed = parseAgentReviewReply(text);
    if (!parsed) return failed('unparseable reply');

    await saveDescription(db, tenantId, agent.id, {
      status: 'ok',
      description: parsed.summary,
      reviewNotes: parsed.concerns,
    });
    return { description: parsed.summary, reviewNotes: parsed.concerns };
  } catch (error) {
    if (error instanceof OperationAbortedError) {
      return failed('operation aborted');
    }
    if (error instanceof RetryExhaustedError) {
      return failed(
        `exhausted after ${error.attempts} attempt${error.attempts === 1 ? '' : 's'}: ${error.lastError.message}`
      );
    }
    return failed(error instanceof Error ? error.message : String(error));
  }
}
