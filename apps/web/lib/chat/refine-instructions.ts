/**
 * Refine a project's instructions: one model call that rewrites the draft
 * an editor has in the About field into clearer, better organized
 * instructions. It never saves anything — the page shows the proposal
 * beside the draft, and the editor takes it into
 * the field (then Save) or discards it (project-about.model.ts).
 *
 * The call forces `propose_instructions`. A model that answers in plain
 * text instead has its text taken as the proposal, so a provider that
 * ignores a forced tool still gives an answer.
 *
 * Its tokens go to the usage ledger under purpose `instructions_refine`,
 * attributed to the editor who asked.
 */

import { resolveAgentLlm, type ResolvedLlm } from '@renkei/agent-llm';
import { recordLlmCall } from '@renkei/agents/runs';
import { isRecord, isString } from '@renkei/guards';
import { logger } from '@/lib/logger';
import { PROJECT_INSTRUCTIONS_MAX_CHARS, type ProjectKind } from './projects';

export const REFINE_TOOL = 'propose_instructions';
/** What the editor may add about what to change, cut before it is sent. */
export const REFINE_GUIDANCE_MAX_CHARS = 2_000;

export interface RefineInput {
  kind: ProjectKind;
  name: string;
  description: string | null;
  /** The draft in the field, saved or not. */
  instructions: string;
  /** What the editor wants changed, if they said ("shorter", "add a tone section"). */
  guidance: string | null;
}

export interface RefineProposal {
  instructions: string;
}

export const REFINE_SYSTEM_PROMPT = [
  'You improve the standing instructions of a project in a chat assistant. Every chat in the project receives these instructions at the start, so they should tell the assistant clearly what the project is about, what it should know, and how it should behave.',
  'Rewrite the draft you are given so it is clear, specific and well organized:',
  '- Keep every fact, requirement, name and preference the draft states, and its intent. Never invent facts, people, systems or rules it does not imply.',
  '- Resolve contradictions and vague wording; where the draft is ambiguous, choose the most likely reading rather than adding questions.',
  '- Address the assistant directly ("You…", imperative). Lead with the project’s purpose, then context, then how to behave and format replies.',
  '- Use short Markdown headings and bullet lists when the draft has more than a few points; keep a short draft short.',
  '- Remove repetition and filler. Do not pad.',
  `- Keep it under ${PROJECT_INSTRUCTIONS_MAX_CHARS.toLocaleString('en-US')} characters.`,
  'If the editor says what they want changed, do that too. Call the propose_instructions tool once with the rewritten instructions. Do not write anything else.',
].join('\n');

export const REFINE_TOOL_DEF = {
  name: REFINE_TOOL,
  description: 'Propose the rewritten project instructions.',
  inputSchema: {
    type: 'object',
    properties: {
      instructions: {
        type: 'string',
        description: 'The complete rewritten instructions, ready to save as they are.',
      },
    },
    required: ['instructions'],
  },
};

/** The user message: the project, the draft, and what the editor asked for. */
export function buildRefinePrompt(input: RefineInput): string {
  const lines = [
    `Project: ${input.name}`,
    input.kind === 'code'
      ? 'Kind: a code project — its chats work in a checkout of a git repository.'
      : 'Kind: a chat project.',
  ];
  if (input.description) lines.push(`Description: ${input.description}`);
  lines.push('', '<draft>', input.instructions, '</draft>');
  const guidance = input.guidance?.trim().slice(0, REFINE_GUIDANCE_MAX_CHARS);
  if (guidance) lines.push('', 'What the editor wants changed:', guidance);
  return lines.join('\n');
}

/** The proposal out of the model's reply: the tool's input, else its text. */
export function parseRefineReply(
  content: readonly { type: string; text?: unknown; name?: unknown; input?: unknown }[]
): RefineProposal | null {
  const call = content.find((block) => block.type === 'tool_use' && block.name === REFINE_TOOL);
  if (call) {
    const input = isRecord(call.input) ? call.input : {};
    const instructions = isString(input.instructions) ? input.instructions.trim() : '';
    if (!instructions) return null;
    return { instructions: instructions.slice(0, PROJECT_INSTRUCTIONS_MAX_CHARS) };
  }
  const text = content
    .flatMap((block) => (block.type === 'text' && isString(block.text) ? [block.text] : []))
    .join('\n')
    .trim();
  return text ? { instructions: text.slice(0, PROJECT_INSTRUCTIONS_MAX_CHARS) } : null;
}

export type RefineOutcome =
  | { ok: true; proposal: RefineProposal }
  | { ok: false; status: 400 | 502 | 503; code: string; error: string };

/** The whole pass: the chosen model (the org's default when none) → a proposal. */
export async function refineInstructions(
  subject: string,
  input: RefineInput,
  llmModelId: string | null
): Promise<RefineOutcome> {
  const resolved = await resolveAgentLlm(llmModelId);
  if (!resolved.ok) {
    return {
      ok: false,
      status: 503,
      code: 'no-model',
      error: 'No model is configured for this organization yet.',
    };
  }
  const llm: ResolvedLlm = resolved.val;
  const startedAt = Date.now();
  const completion = await llm.provider.complete({
    system: REFINE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: buildRefinePrompt(input) }] }],
    tools: [REFINE_TOOL_DEF],
    toolChoice: { name: REFINE_TOOL },
    maxTokens: llm.maxOutputTokens,
    ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
  });
  if (!completion.ok) {
    logger.warn('instructions refine failed: {kind}', {
      component: 'chat/refine-instructions',
      subject,
      kind: completion.err.type,
      message: completion.err.message?.slice(0, 300),
    });
    return {
      ok: false,
      status: 502,
      code: 'model-failed',
      error:
        completion.err.type === 'auth'
          ? "The organization's model rejected its credentials. An operator can fix this under Agent models."
          : 'The model could not refine the instructions. Try again.',
    };
  }
  const usage = completion.val.usage;
  await recordLlmCall({
    subject,
    agentId: null,
    purpose: 'instructions_refine',
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    durationMs: Date.now() - startedAt,
    ...(usage.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: usage.cacheReadInputTokens }
      : {}),
    ...(usage.cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
      : {}),
    model: { provider: llm.providerName, model: llm.model, llmModelId: llm.modelConfigId },
  });
  const proposal = parseRefineReply(completion.val.content);
  if (!proposal) {
    return {
      ok: false,
      status: 502,
      code: 'unreadable',
      error: 'The model replied in a shape this build could not read. Try again.',
    };
  }
  return { ok: true, proposal };
}
