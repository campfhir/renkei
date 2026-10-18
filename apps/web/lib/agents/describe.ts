/**
 * The generated agent description: a save-time LLM pass that summarizes
 * the instructions in the owner's language and flags gaps, so the review
 * panel can say "here's what this agent does — check it".
 *
 * ADVISORY, NEVER BLOCKING. Any failure — no model configured, timeout,
 * malformed reply — records description_status='failed' and the save has
 * already succeeded. Authoring an agent must not depend on the org's model
 * being reachable at that moment.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { describeSchedule, type TriggerDraft } from '@renkei/agents';
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

/**
 * The reviewer prompt, exported so prose drafting can run the SAME critic
 * against a draft before the user ever sees it — the gap-closing loop and
 * the save-time "Worth checking" panel must judge by one set of rules.
 */
export function buildAgentReviewPrompt(
  name: string,
  definition: { instructions: string; tools: string[] },
  triggers: TriggerDraft[],
  guardrails?: string | null
): string {
  const triggerLines =
    triggers.length > 0
      ? triggers.map(describeTrigger).join('; ')
      : 'not yet triggered by anything';

  return [
    `An end user drafted this autonomous agent, named "${name}". It runs ${triggerLines}.`,
    '',
    ...(guardrails?.trim()
      ? [
          'The owner wrote these STANDING GUARDRAILS — the agent must obey them at run time, and instructions that plainly conflict with them are a top-priority concern:',
          guardrails.trim(),
          '',
        ]
      : []),
    'Its instructions:',
    definition.instructions,
    '',
    `Tools it may use: ${definition.tools.length > 0 ? definition.tools.join(', ') : 'none'}.`,
    '',
    'How the platform behaves — take this as given, and never raise a concern the platform already prevents:',
    '- The agent works autonomously from these instructions: it chooses which tools to call, in what order, and retries when something fails. It is not a fixed sequence of steps.',
    '- Every run has hard limits on tool calls and active time; reaching one ends the run. Do not flag missing loop limits or timeouts.',
    '- The agent can never change anything directly: every write (create, update, send, delete) is staged and accepted by the owner or automatically, then carried out by a separate process. Do not flag the lack of an approval step.',
    '- The agent is told what triggered the run and the owner’s name, email and today’s date.',
    '',
    'Reply with JSON only, no code fences: {"summary": "...", "concerns": [{"issue": "...", "fix": "..."}]}.',
    'summary: 2-3 plain sentences telling the OWNER what this agent does, no technical terms, no tool identifiers.',
    'concerns: 0-5 REAL problems a reviewer should check: a goal with no tool that could reach it (name the missing capability), instructions that never say when the job is done, an action described with too little detail for the agent to fill in (which project, which recipient), contradictory rules, or instructions that conflict with the standing guardrails. Each carries "issue" (what is wrong, one sentence) and "fix" (the concrete edit the owner should make, one sentence — which section to add to or how to reword it). Empty array if none.',
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
  agent: {
    id: string;
    name: string;
    instructions: string;
    tools: string[];
    triggers: TriggerDraft[];
    llmModelId: string | null;
    guardrails?: string | null;
  }
): Promise<{ description: string | null; reviewNotes: ReviewNote[] }> {
  const failed = async (reason: string) => {
    logger.debug('agent description generation skipped: {reason}', {
      component: 'agents/describe',
      agentId: agent.id,
      reason,
    });
    await saveDescription(db, agent.id, { status: 'failed' });
    return { description: null, reviewNotes: [] };
  };

  const llmResult = await resolveAgentLlm(db, agent.llmModelId);
  if (!llmResult.ok) return failed(llmResult.err.type);
  const llm = llmResult.val;

  try {
    const completion = await retryWithBackoff(
      () =>
        llm.provider.complete({
          system:
            'You summarize user-drafted agents for the person who wrote them. You reply with strict JSON.',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: buildAgentReviewPrompt(
                    agent.name,
                    { instructions: agent.instructions, tools: agent.tools },
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

    await saveDescription(db, agent.id, {
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
