/**
 * Drafting a CI building block from a description, on the organization's
 * default model — the Building blocks editor's "Draft the block". The
 * draft only fills the form: a person reviews every field and saves it,
 * and only a definition that reads whole can be published.
 *
 * The reply is checked with the same reader the editor and publish use
 * (@renkei/ci-blocks); one with problems goes back to the model with
 * them, once, because "unusable, try again" teaches it nothing.
 */

import { resolveAgentLlm, type LlmErrorKind, type LlmMessage } from '@renkei/agent-llm';
import { BLOCK_KINDS, readBlockDefinition } from '@renkei/ci-blocks';
import { isRecord } from '@renkei/guards';
import { logger } from '@/lib/logger';
import { listBlocks } from './blocks';

const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_OUTPUT_TOKENS = 4_000;
const TIMEOUT_MS = 120_000;

export interface DraftedBlock {
  key: string;
  name: string;
  description: string;
  definition: Record<string, unknown>;
}

function systemPrompt(existing: string[]): string {
  return [
    'You write CI building blocks: one step of a pipeline, written once and rendered by the platform for both Bitbucket Pipelines and GitHub Actions.',
    'Answer with one JSON object and nothing else:',
    '{',
    '  "key": "lower-case-with-dashes",',
    '  "name": "Short human name",',
    '  "description": "One sentence: what it does, and anything a person must check.",',
    '  "definition": {',
    `    "kind": one of ${BLOCK_KINDS.map((k) => `"${k}"`).join(', ')},`,
    '    "runsOn": { "type": "hosted", "image": "node:22" } or { "type": "target" },',
    '    "inputs": [{ "name": "service_name", "type": "text" | "number" | "boolean" | "url", "default": "optional", "description": "..." }],',
    '    "variables": [{ "name": "REGISTRY_TOKEN", "secured": true, "description": "..." }],',
    '    "consumes": ["dist"],',
    '    "produces": [{ "name": "dist", "paths": ["dist"] }],',
    '    "caches": [{ "name": "npm", "path": "~/.npm", "keyFiles": ["package-lock.json"] }],',
    '    "commands": "shell, one command per line"',
    '  }',
    '}',
    'Rules:',
    '- "hosted" runs in a public container image on the host’s own runners; "target" runs directly on self-hosted runner machines the pipeline picks (deploys to on-premises servers). A deploy to the organization’s own machines runs on a target.',
    '- Commands may use ${commit}, ${branch}, ${repo}, ${env} (deploy blocks only) and ${input.NAME} for a declared input. Never use a host’s own variables such as $BITBUCKET_COMMIT or $GITHUB_SHA: the platform spells the placeholders for each host.',
    '- Read variables and secrets as $NAME, and declare every one in "variables" (secured: true for anything secret). Never put a secret value, password, token or host key in the block.',
    '- Inputs are lower_case; variables are UPPER_CASE and may not start with BITBUCKET_, GITHUB_, RUNNER_ or RENKEI_.',
    '- Do not check out the repository or upload artifacts yourself: the platform does that from "consumes" and "produces".',
    '- A deploy should fail loudly when it did not work: check a health URL or exit code, and roll back when the person asked for it.',
    '- Keep it to what was asked. Prefer plain POSIX shell.',
    existing.length > 0
      ? `The organization already has these blocks; do not duplicate one, and choose a key not in this list: ${existing.join(', ')}.`
      : 'The organization has no blocks yet.',
  ].join('\n');
}

/** The JSON object in a reply (a model may wrap it in a fence or a sentence). */
function jsonIn(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function readReply(raw: string): DraftedBlock | { problems: string[] } {
  const reply = jsonIn(raw);
  if (!isRecord(reply)) return { problems: ['Answer with one JSON object, as described.'] };
  const problems: string[] = [];
  const key = typeof reply.key === 'string' ? reply.key.trim() : '';
  if (!/^[a-z][a-z0-9-]{1,79}$/.test(key))
    problems.push('The key must be lower case letters, digits and -, starting with a letter.');
  const name = typeof reply.name === 'string' ? reply.name.trim().slice(0, 200) : '';
  if (!name) problems.push('Give the block a name.');
  const read = readBlockDefinition(reply.definition);
  if (!read.ok) problems.push(...read.errors);
  if (problems.length > 0 || !read.ok) return { problems };
  return {
    key,
    name,
    description:
      typeof reply.description === 'string' ? reply.description.trim().slice(0, 1000) : '',
    definition: { ...read.value },
  };
}

function errorFor(kind: LlmErrorKind): string {
  if (kind === 'auth')
    return 'The model rejected the organization’s API key; an admin can check it under Agent models.';
  if (kind === 'rate_limit' || kind === 'overloaded')
    return 'The model is rate-limiting right now; try again in a minute.';
  if (kind === 'timeout' || kind === 'network')
    return 'The model did not answer in time; try again, or a shorter description.';
  return `The model failed (${kind}); try again, or write the block by hand.`;
}

export async function draftBlock(description: string): Promise<DraftedBlock | { error: string }> {
  const text = description.trim().slice(0, MAX_DESCRIPTION_CHARS);
  if (text.length < 10) return { error: 'Describe the block in a sentence or two.' };
  const resolved = await resolveAgentLlm(null);
  if (!resolved.ok) {
    return {
      error: 'No model is set up for the organization; an admin adds one under Agent models.',
    };
  }
  const llm = resolved.val;
  const existing = (await listBlocks()).map((block) => `${block.key} (${block.name})`);
  const messages: LlmMessage[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: ['The person wrote:', '"""', text, '"""'].join('\n') }],
    },
  ];
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const completion = await llm.provider.complete({
      system: systemPrompt(existing),
      messages,
      tools: [],
      maxTokens: Math.min(MAX_OUTPUT_TOKENS, llm.maxOutputTokens),
      timeoutMs: TIMEOUT_MS,
    });
    if (!completion.ok) {
      logger.warn(
        'a CI building block was not drafted: the model did not answer ({kind}); the editor shows an error',
        {
          component: 'ci/draft-block',
          kind: completion.err.type,
        }
      );
      return { error: errorFor(completion.err.type) };
    }
    const raw = completion.val.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    const read = readReply(raw);
    if (!('problems' in read)) return read;
    problems = read.problems;
    messages.push(
      { role: 'assistant', content: [{ type: 'text', text: raw.slice(0, 20_000) }] },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `That block cannot be used yet:\n${problems.map((p) => `- ${p}`).join('\n')}\nAnswer again with the whole corrected JSON object.`,
          },
        ],
      }
    );
  }
  logger.warn(
    'a CI building block was not drafted: the model’s second answer still did not read ({count} problems); the editor shows them',
    {
      component: 'ci/draft-block',
      count: problems.length,
    }
  );
  return {
    error: `The draft still had problems: ${problems.join(' ')} Try describing it differently, or write it by hand.`,
  };
}
