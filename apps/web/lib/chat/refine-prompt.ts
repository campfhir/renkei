/**
 * Refine a library prompt: one model call that rewrites the draft an editor
 * has in the prompt editor — or, with no draft, writes one from what the
 * editor describes — into a clear prompt that asks for what changes each
 * time through variables (`{{name:type}}` and the trailing ```variables
 * block, lib/chat/prompt-variables.ts), so the prompt opens a form when it
 * is picked, or the assistant asks for the values with chat_ask_form when it
 * is sent as written. It never saves anything: the editor shows the proposal
 * beside the draft, and the editor takes it into the field (then Save) or
 * discards it, as Refine does for a project's instructions
 * (refine-instructions.ts).
 *
 * The call forces `propose_prompt`; a model that answers in plain text has
 * its text taken as the proposal. The proposal is read by the same parser
 * the picker and the form use; when it has problems — an unknown type, a
 * choice with no options, a block entry no placeholder uses — the model is
 * told what they are and asked once more, so what reaches the editor works.
 *
 * Its tokens go to the usage ledger under purpose `prompt_refine`,
 * attributed to the editor who asked, one row per call.
 */

import { resolveAgentLlm, type ResolvedLlm } from '@renkei/agent-llm';
import { MAX_QUESTION_FIELDS, MAX_QUESTION_FIELD_OPTIONS } from '@renkei/agents';
import { recordLlmCall } from '@renkei/agents/runs';
import { isRecord, isString } from '@renkei/guards';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';
import { parsePromptVariables } from './prompt-variables';
import { PROMPT_BODY_MAX_CHARS, PROMPT_TITLE_MAX_CHARS, type PromptLibraryScope } from './prompts';

export const REFINE_PROMPT_TOOL = 'propose_prompt';
/** What the editor may add about what to change, cut before it is sent. */
export const REFINE_PROMPT_GUIDANCE_MAX_CHARS = 2_000;

export interface RefinePromptInput {
  libraryName: string;
  libraryDescription: string | null;
  scope: PromptLibraryScope;
  /** The title in the editor ('' when none yet). */
  title: string;
  /** The draft in the editor, saved or not ('' when there is none: the model writes one). */
  body: string;
  /** What the editor wants ("ask which file", "shorter"), or what to write when there is no draft. */
  guidance: string | null;
}

export interface RefinePromptProposal {
  body: string;
  /** A suggested title, only when the editor has none. */
  title: string | null;
}

/** What the model is told a fix is, for the second go. */
interface Fix {
  previous: string;
  problems: string[];
}

export const REFINE_PROMPT_SYSTEM_PROMPT = [
  'You help people write reusable prompts for a chat assistant. A prompt lives in a library and is inserted into a chat message when someone picks it. You write the whole prompt, ready to save.',
  '',
  'Write a clear, specific prompt:',
  '- Keep every fact, requirement and preference the draft states, and its intent. Never invent facts, names, systems or rules it does not imply.',
  '- Address the assistant directly, in the imperative. Say the task, the context it needs, and the shape of the answer wanted.',
  '- Use short Markdown headings or bullet lists only when the prompt has several parts; keep a short prompt short. Remove filler and repetition.',
  `- Keep it under ${PROMPT_BODY_MAX_CHARS.toLocaleString('en-US')} characters.`,
  '',
  'Put what changes from one use to the next into variables, so whoever uses the prompt is asked for it instead of editing the text:',
  '- Write {{name}} where a value goes, or {{name:type}} to say what kind of answer it is. A name is letters, digits and underscores, starting with a letter or underscore: {{file}}, {{target_branch}}.',
  '- Types: text (a short line, the default), longtext (a paragraph), number, date, choice (pick one of a few options, shown as radio buttons), multi (pick several, shown as checkboxes).',
  '- The same name used twice is asked once and filled in both places.',
  '- Use a variable for a value the person would otherwise have to rewrite each time — a file, a branch, a ticket, a goal, a deadline, an audience, a level of detail. Do not turn fixed wording into variables, and do not add one the task does not need. A prompt with nothing that varies has no variables.',
  `- At most ${MAX_QUESTION_FIELDS} variables. Prefer the fewest that matter.`,
  '',
  'When a variable needs more than its type, add a block at the very end of the prompt, after a blank line, fenced exactly like this (YAML, one entry per variable you want to set up):',
  '```variables',
  'file:',
  '  required: true',
  '  help: Path in the repository',
  'focus:',
  '  options: [security, performance, readability]',
  '  default: security',
  '```',
  `Keys: required (true: the form cannot be sent without an answer), help (one short line under the control), label (the question, when the name reads badly), options (a list, for choice and multi: at least two and at most ${MAX_QUESTION_FIELD_OPTIONS}, each short), default (a starting answer; for multi a list; it must be one of the options), min and max (for number), type (instead of writing it in the placeholder). A choice or multi must list its options in the block. Mark a variable required only when the prompt cannot work without it. Every entry in the block must name a variable that appears in the prompt above it. Omit the block when no variable needs it. Never put a fenced block anywhere else in the prompt.`,
  '',
  'How the variables are used: picking the prompt opens a form with one control per variable, and the filled-in prompt goes in the message box. Or the prompt is sent as written and the assistant asks the person for the values in a form in the chat. Either way the questions are the variables, so name and label them as a question a person would understand.',
  '',
  'If the library is for code projects, the prompt is used in a chat that works in a checkout of a git repository: it may name files, branches, tests and pull requests. Do not assume any particular language or framework the draft does not mention.',
  'If the editor says what they want changed, or — when there is no draft — what the prompt is for, do that. If the title is empty, suggest a short one (a few words); otherwise leave the title alone.',
  'Call the propose_prompt tool once with the complete prompt. Do not write anything else.',
].join('\n');

export const REFINE_PROMPT_TOOL_DEF = {
  name: REFINE_PROMPT_TOOL,
  description: 'Propose the rewritten prompt.',
  inputSchema: {
    type: 'object',
    properties: {
      body: {
        type: 'string',
        description:
          'The complete prompt, including its {{variables}} and, at the very end, its ```variables block when it needs one. Ready to save as it is.',
      },
      title: {
        type: 'string',
        description: 'A short title (a few words), only when the editor has not given one.',
      },
    },
    required: ['body'],
  },
};

/** The user message: the library, the draft (or its absence), what was asked, and a fix when it is the second go. */
export function buildRefinePromptMessage(input: RefinePromptInput, fix?: Fix): string {
  const lines = [
    `Library: ${input.libraryName}`,
    input.scope === 'code'
      ? 'Offered in: code projects only — chats that work in a checkout of a git repository.'
      : 'Offered in: every chat.',
  ];
  if (input.libraryDescription) lines.push(`Description: ${input.libraryDescription}`);
  lines.push(input.title.trim() ? `Title: ${input.title.trim()}` : 'Title: (none yet)');
  if (input.body.trim()) {
    lines.push('', '<draft>', input.body.trim(), '</draft>');
  } else {
    lines.push('', 'There is no draft yet: write the prompt from what the editor describes.');
  }
  const guidance = input.guidance?.trim().slice(0, REFINE_PROMPT_GUIDANCE_MAX_CHARS);
  if (guidance) {
    lines.push(
      '',
      input.body.trim() ? 'What the editor wants changed:' : 'What the prompt is for:',
      guidance
    );
  }
  if (fix) {
    lines.push(
      '',
      'Your previous attempt:',
      '<previous>',
      fix.previous,
      '</previous>',
      'It has these problems, which the form cannot work around:',
      ...fix.problems.map((problem) => `- ${problem}`),
      'Fix them and propose the prompt again.'
    );
  }
  return lines.join('\n');
}

/** The proposal out of the model's reply: the tool's input, else its text. */
export function parseRefinePromptReply(
  content: readonly { type: string; text?: unknown; name?: unknown; input?: unknown }[]
): RefinePromptProposal | null {
  const call = content.find(
    (block) => block.type === 'tool_use' && block.name === REFINE_PROMPT_TOOL
  );
  if (call) {
    const input = isRecord(call.input) ? call.input : {};
    const body = isString(input.body) ? input.body.trim() : '';
    if (!body) return null;
    const title = isString(input.title) ? input.title.trim() : '';
    return {
      body: body.slice(0, PROMPT_BODY_MAX_CHARS),
      title: title ? title.slice(0, PROMPT_TITLE_MAX_CHARS) : null,
    };
  }
  const text = content
    .flatMap((block) => (block.type === 'text' && isString(block.text) ? [block.text] : []))
    .join('\n')
    .trim();
  return text ? { body: text.slice(0, PROMPT_BODY_MAX_CHARS), title: null } : null;
}

/** What a proposal's variables got wrong, in the parser's own words. */
export function proposalProblems(proposal: RefinePromptProposal): string[] {
  return parsePromptVariables(proposal.body).problems;
}

export type RefinePromptOutcome =
  | { ok: true; proposal: RefinePromptProposal }
  | { ok: false; status: 400 | 502 | 503; code: string; error: string };

type Asked =
  | { ok: true; proposal: RefinePromptProposal }
  | { ok: false; failure: Extract<RefinePromptOutcome, { ok: false }> };

async function askOnce(
  subject: string,
  llm: ResolvedLlm,
  input: RefinePromptInput,
  fix?: Fix
): Promise<Asked> {
  const startedAt = Date.now();
  const completion = await llm.provider.complete({
    system: REFINE_PROMPT_SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: [{ type: 'text', text: buildRefinePromptMessage(input, fix) }] },
    ],
    tools: [REFINE_PROMPT_TOOL_DEF],
    toolChoice: { name: REFINE_PROMPT_TOOL },
    maxTokens: llm.maxOutputTokens,
    ...(llm.temperature !== undefined ? { temperature: llm.temperature } : {}),
  });
  if (!completion.ok) {
    logger.warn(
      '{actor} asked for their prompt to be refined, but the model did not answer ({kind}); they saw an error',
      {
        component: 'chat/refine-prompt',
        ...(await whoIs(subject)),
        kind: completion.err.type,
        message: completion.err.message?.slice(0, 300),
      }
    );
    return {
      ok: false,
      failure: {
        ok: false,
        status: 502,
        code: 'model-failed',
        error:
          completion.err.type === 'auth'
            ? "The organization's model rejected its credentials. An operator can fix this under Agent models."
            : 'The model could not refine the prompt. Try again.',
      },
    };
  }
  const usage = completion.val.usage;
  await recordLlmCall({
    subject,
    agentId: null,
    purpose: 'prompt_refine',
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
  const proposal = parseRefinePromptReply(completion.val.content);
  if (!proposal) {
    return {
      ok: false,
      failure: {
        ok: false,
        status: 502,
        code: 'unreadable',
        error: 'The model replied in a shape this build could not read. Try again.',
      },
    };
  }
  return { ok: true, proposal };
}

/**
 * The whole pass: the chosen model (the org's default when none) → a
 * proposal whose variables the parser reads cleanly, asking once more when
 * the first does not and keeping whichever of the two has fewer problems.
 */
export async function refinePrompt(
  subject: string,
  input: RefinePromptInput,
  llmModelId: string | null
): Promise<RefinePromptOutcome> {
  const resolved = await resolveAgentLlm(llmModelId);
  if (!resolved.ok) {
    return {
      ok: false,
      status: 503,
      code: 'no-model',
      error: 'No model is configured for this organization yet.',
    };
  }
  const llm = resolved.val;
  const first = await askOnce(subject, llm, input);
  if (!first.ok) return first.failure;
  const problems = proposalProblems(first.proposal);
  if (problems.length === 0) return { ok: true, proposal: first.proposal };

  const second = await askOnce(subject, llm, input, {
    previous: first.proposal.body,
    problems,
  });
  // A failed second go is not a failed refine: the first answer still works, with its fallbacks.
  if (!second.ok) return { ok: true, proposal: first.proposal };
  const better =
    proposalProblems(second.proposal).length <= problems.length ? second.proposal : first.proposal;
  return { ok: true, proposal: better };
}
