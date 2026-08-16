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
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { BUILTIN_VARIABLES, type AgentStep, type InstructionSegment } from '@renkei/agents';
import { resolveAgentLlm } from '@renkei/agent-llm';
import type { ToolDescriptor } from '@/lib/mcp-tools/tool-catalog';
import { friendlyToolName } from '@/lib/tool-name';
import { logger } from '@/lib/logger';

const DRAFT_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 4_096;
const MAX_PROSE_CHARS = 4_000;

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

function promptOf(
  text: string,
  tools: ToolDescriptor[],
  currentSteps: AgentStep[],
  triggerVars: string[]
): string {
  const toolLines = tools
    .filter((tool) => !tool.appOnly)
    .map(
      (tool) =>
        `- ${tool.name} (${friendlyToolName(tool.name, tool.title)}): ${(tool.description ?? '').slice(0, 100)}`
    )
    .join('\n');
  const varLines = [
    ...BUILTIN_VARIABLES.map((variable) => `- ${variable.name}: ${variable.description}`),
    ...triggerVars.map((name) => `- ${name}: provided by a trigger when the automation starts`),
  ].join('\n');

  const revising = currentSteps.length > 0;
  const currentLines = currentSteps
    .map(
      (step, index) =>
        `s${index + 1}. "${step.name}" — ${segmentsToTokens(step.instruction)}` +
        (step.saveAs ? ` (saves result as "${step.saveAs}")` : '')
    )
    .join('\n');

  return [
    revising
      ? 'A user wants to CHANGE an existing automation. Apply exactly the change they describe — add, remove, reorder, or tweak steps as asked — and return the FULL revised step list. Echo steps the change does not touch VERBATIM (same instruction tokens, same saveAs).'
      : 'A user described an automation in plain words. Split it into ordered steps for a step-runner.',
    'Rules:',
    '- Each step does ONE thing and may use AT MOST ONE tool from the list below (a step may also be pure reasoning with no tool).',
    '- Mark the tool in the instruction as {{tool:tool_name}} and reference known variables as {{var:name}}. Use ONLY tools and variables from the lists.',
    '- When a later step needs an earlier step\'s result, give the earlier step a short "saveAs" name (spaces allowed, e.g. "the ticket") and reference it as {{var:the ticket}}.',
    '- Steps run in order; a failed step stops the automation, so no fallback steps are needed.',
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
    'Available variables (more may exist from triggers; use only these unless the user names trigger data — then use {{var:trigger.<name>}} as they describe it):',
    varLines,
    '',
    revising ? 'The user asked for this change:' : 'The user wrote:',
    '"""',
    text,
    '"""',
    '',
    'Reply with JSON only, no code fences:',
    `{"name": "short agent name", "steps": [{"name": "short step name", "instruction": "plain words with {{tool:...}} and {{var:...}} tokens", "tool": "tool_name or null", "saveAs": "name or null"${revising ? ', "from": "sN or null"' : ''}}]}`,
  ].join('\n');
}

const TOKEN_PATTERN = /\{\{(tool|var):([^}]{1,128})\}\}/g;

/** Token string → segments, keeping only chips that verify. */
function segmentsOf(
  instruction: string,
  validTools: Set<string>,
  knownVars: Set<string>
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
    if (kind === 'tool' && validTools.has(name) && !toolPlaced) {
      segments.push({ t: 'tool', name });
      toolPlaced = true;
    } else if (kind === 'var' && (knownVars.has(name) || name.startsWith('trigger.'))) {
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

export interface DraftedAgent {
  name: string;
  steps: AgentStep[];
}

export async function draftAgentFromProse(
  db: Kysely<DB>,
  tenantId: string,
  text: string,
  tools: ToolDescriptor[],
  options: {
    /** Present when revising: the builder's CURRENT (possibly unsaved) steps. */
    currentSteps?: AgentStep[];
    /** trigger.* names the attached triggers provide, so those chips verify. */
    triggerVars?: string[];
  } = {}
): Promise<DraftedAgent | { error: string }> {
  const currentSteps = options.currentSteps ?? [];
  const triggerVars = options.triggerVars ?? [];
  const llmResult = await resolveAgentLlm(db, tenantId, null);
  if (!llmResult.ok) {
    return { error: 'No model is configured for this organization yet.' };
  }
  const llm = llmResult.val;

  const completion = await Promise.race([
    llm.provider.complete({
      system:
        'You turn plain-language automation descriptions into structured steps. You reply with strict JSON.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: promptOf(text.slice(0, MAX_PROSE_CHARS), tools, currentSteps, triggerVars),
            },
          ],
        },
      ],
      tools: [],
      maxTokens: MAX_OUTPUT_TOKENS,
    }),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), DRAFT_TIMEOUT_MS)),
  ]);
  if (completion === 'timeout') return { error: 'The model took too long — try again.' };
  if (!completion.ok) {
    logger.warn('prose draft failed: {kind}', {
      component: 'agents/draft',
      tenantId,
      kind: completion.err.type,
    });
    return { error: 'The model could not draft steps — try again or write them by hand.' };
  }

  const raw = completion.val.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .replace(/```(?:json)?/g, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { error: 'The model gave an unusable answer — try again.' };

  let parsed: { name?: unknown; steps?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { error: 'The model gave an unusable answer — try again.' };
  }
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    return { error: 'The model found no steps in that description — add more detail.' };
  }

  const validTools = new Set(tools.filter((tool) => !tool.appOnly).map((tool) => tool.name));
  const knownVars = new Set([
    ...BUILTIN_VARIABLES.map((variable) => variable.name),
    ...triggerVars,
    // Existing saveAs names stay referenceable even before their step is
    // re-emitted (the model may reorder).
    ...currentSteps.flatMap((step) => (step.saveAs ? [step.saveAs] : [])),
  ]);

  const steps: AgentStep[] = [];
  for (const entry of parsed.steps.slice(0, 20)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const step: { name?: unknown; instruction?: unknown; saveAs?: unknown; from?: unknown } = entry;
    if (typeof step.instruction !== 'string' || !step.instruction.trim()) continue;

    const segments = segmentsOf(step.instruction, validTools, knownVars);
    const tool = segments.find(
      (segment): segment is Extract<InstructionSegment, { t: 'tool' }> => segment.t === 'tool'
    );

    // "from": sN → the existing step this one is based on. Its identity,
    // attempt budget, and — when the tool didn't change — failure handling
    // survive the revision; the model only authors words and chips.
    const fromMatch = typeof step.from === 'string' ? /^s(\d+)$/.exec(step.from.trim()) : null;
    const origin = fromMatch ? currentSteps[Number(fromMatch[1]) - 1] : undefined;
    const sameTool = origin !== undefined && origin.tool === (tool?.name ?? null);

    const saveAs =
      typeof step.saveAs === 'string' && step.saveAs.trim() ? step.saveAs.trim() : origin?.saveAs;
    if (saveAs) knownVars.add(saveAs); // later steps may reference it

    steps.push({
      id: origin?.id ?? randomUUID(),
      name: typeof step.name === 'string' ? step.name.slice(0, 80) : (origin?.name ?? ''),
      instruction: segments,
      tool: tool?.name ?? null,
      maxAttempts: origin?.maxAttempts ?? 3,
      // Failure conditions belong to a tool; a changed tool starts clean.
      failureHandling: sameTool ? origin.failureHandling : [],
      ...(saveAs ? { saveAs } : {}),
    });
  }
  // A model that echoes the same origin twice would duplicate ids; keep the
  // first claim, regenerate the rest.
  const seenIds = new Set<string>();
  for (const step of steps) {
    if (seenIds.has(step.id)) step.id = randomUUID();
    seenIds.add(step.id);
  }
  if (steps.length === 0) {
    return { error: 'The model found no usable steps — add more detail.' };
  }

  return {
    name: typeof parsed.name === 'string' ? parsed.name.slice(0, 200) : '',
    steps,
  };
}
