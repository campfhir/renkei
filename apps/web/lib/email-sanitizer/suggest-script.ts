/**
 * Org-model-drafted cleaner scripts: a pasted sample (plus optional
 * instructions) in, a `(email) => string` function out — pre-flown before
 * the admin ever sees it. The model's output is never trusted as-is:
 *
 *  1. the source must pass validateCleanerScriptSource (parses, is a
 *     function), and
 *  2. it is RUN against the sample in the exact production sandbox; a
 *     script that throws or times out on its own motivating example is
 *     returned as an error, not a suggestion.
 *
 * What survives lands in the editor for the admin to read, re-test and
 * save — same trust model as rule and phrase suggestions: the model
 * proposes, a person enables.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { resolveAgentLlm } from '@renkei/agent-llm';
import {
  runCleanerScript,
  validateCleanerScriptSource,
  MAX_SCRIPT_CHARS,
  type CleanerScriptKind,
} from '@renkei/email-sanitizer';
import { logger } from '@/lib/logger';

const SUGGEST_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 3_000;
const MAX_SAMPLE_CHARS = 20_000;

export interface ScriptSuggestion {
  name: string;
  script: string;
  rationale: string;
  /** The script's output on the supplied sample — instant before/after. */
  sampleOutput: string;
}

const KIND_BRIEF: Record<CleanerScriptKind, string[]> = {
  msg: [
    'This script cleans EMAIL (email.kind === "msg"). The boilerplate to expect is signature',
    'blocks, social-link rows, injected banners and legal footers.',
  ],
  evt: [
    'This script cleans CALENDAR INVITES (email.kind === "evt"). The boilerplate to expect is the',
    'conferencing block Teams/Zoom/Webex staple onto every invite — "Join the meeting now",',
    '"Find a local number", "For organizers: Meeting options". It is identical across every',
    'meeting in the organization, which is exactly why it is worth removing.',
    'CRITICAL: never drop a line carrying a join link, a meeting id, a passcode or a phone',
    'number. Losing those makes the invite useless; leaving a stray line of chrome does not.',
  ],
  task: [
    'This script cleans TASKS (email.kind === "task") from Microsoft To Do and Planner. Bodies',
    'are short; be especially conservative, since there is little text to spare.',
  ],
};

function promptOf(sample: string, instructions: string, kind: CleanerScriptKind): string {
  return [
    'You write cleaner scripts for a content sanitizer. A cleaner script is ONE JavaScript',
    'function expression `(email) => string` that transforms a body before indexing —',
    'stripping organization boilerplate while preserving what a person actually wrote.',
    '',
    ...KIND_BRIEF[kind],
    '',
    'The function receives `email` (also available as `item`) with:',
    '- text: the body as cleaned so far (transform and return this)',
    '- kind: "msg" | "evt" | "task" — branch on this if the script serves more than one',
    '- subject, fromAddress, fromName',
    '- senderAddress, replyToAddress, messageId, receivedAt (string or null — header fields;',
    '  useful to branch on, e.g. only strip when replyToAddress is a no-reply relay)',
    '- organizer, attendees (array of strings), location, startsAt, endsAt, isOnline —',
    '  populated for calendar invites, empty otherwise',
    '',
    'Sandbox constraints (hard):',
    '- Pure ES2020: no require/import, no fetch, no fs, no process, no timers, no Date.now.',
    '- Must finish fast (250ms budget) — linear passes over the text, no heavy loops.',
    '- Must return a string. Return email.text unchanged when nothing applies.',
    '- Be conservative: prefer dropping clearly-boilerplate lines over aggressive rewrites,',
    '  and make patterns robust to line-wrap and whitespace differences.',
    '',
    ...(instructions
      ? ['The administrator asked for this behavior:', `"""${instructions}"""`, '']
      : []),
    'Sample email body the script must handle:',
    '"""',
    sample,
    '"""',
    '',
    'Reply with JSON only, no code fences:',
    '{"name": "short script name", "script": "(email) => { ... }", ' +
      '"rationale": "one or two sentences on what it strips and how it stays safe"}',
  ].join('\n');
}

export async function suggestCleanerScript(
  db: Kysely<DB>,
  tenantId: string,
  rawSample: string,
  rawInstructions: string,
  kind: CleanerScriptKind = 'msg'
): Promise<ScriptSuggestion | { error: string }> {
  const sample = rawSample.slice(0, MAX_SAMPLE_CHARS);
  if (sample.trim().length < 40) {
    return { error: 'Paste a fuller sample — a few lines are not enough to write against.' };
  }
  const instructions = rawInstructions.trim().slice(0, 2_000);

  const llmResult = await resolveAgentLlm(db, tenantId, null);
  if (!llmResult.ok) {
    return { error: 'No model is configured for this organization.' };
  }
  const llm = llmResult.val;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const completion = await Promise.race([
    llm.provider.complete({
      system: 'You write small, safe JavaScript functions. You reply with strict JSON.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: promptOf(sample, instructions, kind) }] },
      ],
      tools: [],
      maxTokens: Math.max(MAX_OUTPUT_TOKENS, llm.maxOutputTokens),
    }),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SUGGEST_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (completion === 'timeout') return { error: 'The model took too long — try again.' };
  if (!completion.ok) {
    logger.warn('script drafting failed: {kind} {message}', {
      component: 'email-sanitizer/suggest',
      tenantId,
      kind: completion.err.type,
      message: completion.err.message?.slice(0, 300) ?? '',
    });
    return { error: 'The model could not draft a script — try again later.' };
  }

  const raw = completion.val.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .replace(/```(?:json|javascript|js)?/g, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { error: 'The model gave an unusable answer.' };

  let parsed: { name?: unknown; script?: unknown; rationale?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { error: 'The model gave an unusable answer.' };
  }
  const script = typeof parsed.script === 'string' ? parsed.script.trim() : '';
  if (!script) return { error: 'The model wrote no script.' };
  if (script.length > MAX_SCRIPT_CHARS) {
    return { error: 'The model wrote an oversized script — try simpler instructions.' };
  }

  // Pre-flight 1: the source itself must be a function.
  const valid = await validateCleanerScriptSource(script);
  if (!valid.ok) {
    return { error: `The drafted script does not compile: ${valid.error}` };
  }

  // Pre-flight 2: it must actually RUN on the sample it was written for —
  // in the exact production sandbox, same limits.
  const ran = await runCleanerScript(script, {
    text: sample,
    kind,
    subject: '(sample)',
    fromAddress: 'sample@example.com',
    fromName: 'Sample',
    senderAddress: null,
    replyToAddress: null,
    messageId: null,
    receivedAt: null,
  });
  if (!ran.ok) {
    return {
      error: `The drafted script failed on your own sample (${ran.err.type}: ${ran.detail ?? ''}) — try again.`,
    };
  }

  return {
    name: typeof parsed.name === 'string' ? parsed.name.slice(0, 120) : 'Drafted cleaner',
    script,
    rationale:
      typeof parsed.rationale === 'string'
        ? parsed.rationale.slice(0, 500)
        : 'Drafted from the sample.',
    sampleOutput: ran.val,
  };
}
