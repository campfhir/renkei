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

const GENERATION_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 1_024;

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
  const failure = step.failureHandling
    .map((handling) =>
      handling.action === 'retry'
        ? `on "${handling.outcome}" retry (max ${step.maxAttempts} attempts) with: ${instructionPreview(handling.guidance ?? [])}`
        : `on "${handling.outcome}" stop`
    )
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
        case undefined:
          return actionStepLines(node, label, indent);
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
        default: {
          const unhandled: never = node;
          throw new Error(`unknown step kind: ${JSON.stringify(unhandled)}`);
        }
      }
    })
    .join('\n');
}

function promptOf(name: string, steps: AgentStepsDoc, triggers: TriggerDraft[]): string {
  const ordinals = new Map(walkSteps(steps.steps).map((entry) => [entry.node.id, entry.ordinal]));
  const stepLines = nodeLines(steps.steps, ordinals, '');
  const triggerLines =
    triggers.length > 0
      ? triggers.map(describeTrigger).join('; ')
      : 'not yet triggered by anything';

  return [
    `An end user drafted this automation, named "${name}". It runs ${triggerLines}.`,
    '',
    'Steps (variables appear as [name], tools as [tool_name]):',
    stepLines,
    '',
    'How the engine behaves — take this as given, and never raise a concern the engine already prevents:',
    '- Steps run in document order. Inside a branch, exactly ONE path runs (the engine forces a choice; the last path is the fallback). A loop repeats its body up to its stated round limit; a for-each loop over an empty list simply skips. After a branch or loop finishes, execution continues below it.',
    '- A later step runs ONLY if everything before it on its route succeeded.',
    '- A failure handled with "stop", an unhandled failure, or exhausted retries STOPS the whole automation immediately — later steps never run, so they can safely assume earlier steps succeeded. Missing "fallbacks" for exhausted retries are not a flaw. A branch\'s failure route (when present) already covers the decision itself erroring.',
    "- The runner checks each step's tool is available before running, and verifies tool errors against the declared success.",
    '- Loop round limits and the collected-list size are engine-enforced ceilings with truncation notes — do not flag them as missing safeguards.',
    '',
    'Reply with JSON only, no code fences: {"summary": "...", "concerns": [{"issue": "...", "fix": "..."}]}.',
    'summary: 2-3 plain sentences telling the OWNER what this agent does, no technical terms, no tool identifiers.',
    'concerns: 0-5 REAL logic problems a reviewer should check: an instruction promising work no step or tool performs, a step needing information nothing provides, contradictory failure handling, a saved result nothing uses. Each carries "issue" (what is wrong, one sentence) and "fix" (the concrete edit the owner should make, one sentence, e.g. which step to add or how to reword an instruction). Empty array if none.',
    'When naming a step, use its number EXACTLY as labeled above ("Step 7") — the owner sees these same numbers in the editor. Never invent dotted numbering like "Step 5.1.2".',
  ].join('\n');
}

function parseReply(text: string): { summary: string; concerns: ReviewNote[] } | null {
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

  const completion = await Promise.race([
    llm.provider.complete({
      system:
        'You summarize user-drafted automations for the person who wrote them. You reply with strict JSON.',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: promptOf(agent.name, agent.steps, agent.triggers) }],
        },
      ],
      tools: [],
      maxTokens: Math.max(MAX_OUTPUT_TOKENS, llm.maxOutputTokens),
    }),
    new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), GENERATION_TIMEOUT_MS)
    ),
  ]);
  if (completion === 'timeout') return failed('timeout');
  if (!completion.ok) {
    return failed(
      `${completion.err.type}${completion.err.message ? `: ${completion.err.message.slice(0, 300)}` : ''}`
    );
  }

  const text = completion.val.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
  const parsed = parseReply(text);
  if (!parsed) return failed('unparseable reply');

  await saveDescription(db, tenantId, agent.id, {
    status: 'ok',
    description: parsed.summary,
    reviewNotes: parsed.concerns,
  });
  return { description: parsed.summary, reviewNotes: parsed.concerns };
}
