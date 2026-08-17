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
import { instructionPreview, type AgentStepsDoc, type TriggerDraft } from '@renkei/agents';
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
      return `on a schedule (${JSON.stringify(draft.recurrence)})`;
    case 'agent':
      return 'after another agent finishes';
    case 'api':
      return 'when called over the API';
  }
}

function promptOf(name: string, steps: AgentStepsDoc, triggers: TriggerDraft[]): string {
  const stepLines = steps.steps
    .map((step, index) => {
      const failure = step.failureHandling
        .map((handling) =>
          handling.action === 'retry'
            ? `on "${handling.outcome}" retry (max ${step.maxAttempts} attempts) with: ${instructionPreview(handling.guidance ?? [])}`
            : `on "${handling.outcome}" stop`
        )
        .join('; ');
      return [
        `${index + 1}. ${step.name}`,
        `   does: ${instructionPreview(step.instruction)}`,
        step.tool ? `   tool: ${step.tool}` : '   tool: none (reasoning only)',
        step.saveAs ? `   saves result as: ${step.saveAs}` : null,
        failure ? `   failure handling: ${failure}` : '   failure handling: stop on any failure',
      ]
        .filter((line): line is string => line !== null)
        .join('\n');
    })
    .join('\n');
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
    '- Steps run strictly in order; a later step runs ONLY if every earlier step succeeded.',
    '- A failure handled with "stop", an unhandled failure, or exhausted retries STOPS the whole automation immediately — later steps never run, so they can safely assume earlier steps succeeded. Missing "fallbacks" for exhausted retries are not a flaw.',
    "- The runner checks each step's tool is available before running, and verifies tool errors against the declared success.",
    '',
    'Reply with JSON only, no code fences: {"summary": "...", "concerns": [{"issue": "...", "fix": "..."}]}.',
    'summary: 2-3 plain sentences telling the OWNER what this agent does, no technical terms, no tool identifiers.',
    'concerns: 0-5 REAL logic problems a reviewer should check: an instruction promising work no step or tool performs, a step needing information nothing provides, contradictory failure handling, a saved result nothing uses. Each carries "issue" (what is wrong, one sentence) and "fix" (the concrete edit the owner should make, one sentence, e.g. which step to add or how to reword an instruction). Empty array if none.',
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
    logger.info('agent description generation skipped: {reason}', {
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
