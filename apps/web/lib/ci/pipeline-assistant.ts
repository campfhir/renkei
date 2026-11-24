/**
 * The pipeline builder's assistant: a short conversation, on the project's
 * own model (else the person's, else the organization's default), that
 * reads the repository through the host — the person's own grant, the
 * same reads the code pane makes — and tailors the pipeline to it.
 *
 * It answers in words and, when it has something to change, with a
 * proposal: the whole pipeline as it would be, with the blocks it wrote
 * for this project (PipelineSpec.blocks). A proposal only fills the
 * builder when the person applies it; nothing is saved and nothing
 * reaches the repository until they save or open the pull request.
 *
 * For an operator it can also turn a project's block into a building
 * block for every project — the project's own values made inputs — which
 * the page saves as a draft in the organization's catalogue for the
 * operator to review and publish.
 *
 * Each proposal is read with the same readers the builder and the
 * catalogue use (@renkei/ci-blocks); one that does not read goes back to
 * the model as the tool's error, so it fixes what is named.
 */

import type {
  LlmContentBlock,
  LlmErrorKind,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmToolDef,
} from '@renkei/agent-llm';
import {
  BLOCK_KINDS,
  HOST_LABEL,
  PIPELINE_FILE,
  blockOfStep,
  readBlockDefinition,
  readPipelineSpec,
  renderPipeline,
  type BlockDefinition,
  type BlockKind,
  type CheckTarget,
  type Host,
  type PipelineBlock,
  type PipelineSpec,
} from '@renkei/ci-blocks';
import { isRecord } from '@renkei/guards';
import { isMap, parseDocument } from 'yaml';
import type { Result } from '@campfhir/safe-functions/types';

export const MAX_CONVERSATION_TURNS = 20;
/** The reply when a turn ends before the model answered (out of rounds, or cut off with nothing in it). */
export const UNFINISHED =
  'I ran out of room before I finished, so nothing is proposed yet; say “continue” and I will pick up from here.';
export const UNFINISHED_AFTER_PROPOSING =
  'I ran out of room before I finished; say “continue” if there is more to do.';
export const MAX_MESSAGE_CHARS = 4_000;
const MAX_FILE_READS = 25;
const MAX_LISTINGS = 40;
/** Model round trips in one turn: a backstop, far past what a real request takes. */
export const MAX_ROUNDS = 100;
/** Proposals that did not read (or were cut off) before the turn gives up. */
export const MAX_FAILED_PROPOSALS = 3;
const MAX_FILE_CHARS = 40_000;
const MAX_LISTED = 300;
const MAX_OUTPUT_TOKENS = 16_000;
const TIMEOUT_MS = 120_000;
const BLOCK_KEY = /^[a-z][a-z0-9-]{1,79}$/;

export interface AssistantTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** The pipeline as the assistant would have it, its own blocks included. */
export interface PipelineProposal {
  summary: string;
  spec: PipelineSpec;
  /** What the file cannot be written for yet (an input to fill in, a target to pick). */
  unfinished: string[];
}

/** A block for the organization's catalogue, made from one of the project's (operators). */
export interface BuildingBlockProposal {
  key: string;
  name: string;
  description: string;
  kind: BlockKind;
  definition: BlockDefinition;
  /** The project's block it was made from. */
  from: string | null;
}

/** A pipeline file written by hand, as the assistant would have it: the whole file. */
export interface FileProposal {
  summary: string;
  /** The file it is for, as the page named it. */
  name: string;
  text: string;
}

export interface AssistantReply {
  reply: string;
  proposal: PipelineProposal | null;
  buildingBlock: BuildingBlockProposal | null;
  /** The edited file, when the conversation is about one written by hand. */
  file?: FileProposal | null;
  /** The repository paths it read or listed, in order, for the page to show. */
  read: string[];
}

type Listing =
  { ok: true; entries: { path: string; kind: 'file' | 'dir' }[] } | { ok: false; error: string };
type FileRead =
  { ok: true; text: string; truncated: boolean; binary: boolean } | { ok: false; error: string };

export interface AssistantDeps {
  complete: (request: LlmRequest) => Promise<Result<LlmResponse, LlmErrorKind>>;
  maxOutputTokens: number;
  listFiles: (path: string) => Promise<Listing>;
  readFile: (path: string) => Promise<FileRead>;
  /** What it is doing now, as the person reads it ("Reading package.json"). */
  onStep?: (step: string) => Promise<void> | void;
}

export interface AssistantInput {
  conversation: AssistantTurn[];
  /** The pipeline as the builder has it — read whole, or as sent when it does not read yet. */
  spec: unknown;
  /** Why the builder's pipeline does not read yet; empty when it does. */
  specProblems?: string[];
  host: Host;
  repo: string;
  /** The branch whose pipeline this is: its file lives there, and it is read from there. */
  branch: string;
  /** The environment the branch is assigned to: what merges to it deploy. */
  environment: string;
  /** The organization's published blocks (every version the builder knows). */
  blocks: (PipelineBlock & { description: string | null })[];
  targets: CheckTarget[];
  /** Offers the tool that makes a building block for every project. */
  operator: boolean;
  /**
   * The pipeline file open in the page's editor, when the branch's pipeline
   * was written by hand: the conversation is then about that file, as text,
   * and the assistant proposes the whole file edited instead of a pipeline
   * of blocks.
   */
  file?: { name: string; text: string };
}

/** A conversation as sent: the last turns, each trimmed, ending on the person's. */
export function readConversation(value: unknown): AssistantTurn[] | { error: string } {
  if (!Array.isArray(value)) return { error: 'Send the conversation.' };
  const turns: AssistantTurn[] = [];
  for (const raw of value.slice(-MAX_CONVERSATION_TURNS)) {
    if (!isRecord(raw)) continue;
    const role = raw.role === 'assistant' ? 'assistant' : raw.role === 'user' ? 'user' : null;
    const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, MAX_MESSAGE_CHARS) : '';
    if (role && text) turns.push({ role, text });
  }
  while (turns.length > 0 && turns[0].role !== 'user') turns.shift();
  if (turns.length === 0 || turns[turns.length - 1].role !== 'user') {
    return { error: 'Say what you would like the assistant to do.' };
  }
  return turns;
}

/** A repository path the model named: relative, no `..`, no leading or trailing slash. */
export function cleanPath(value: unknown): string | null {
  const path = typeof value === 'string' ? value.trim().replace(/^\.?\/+|\/+$/g, '') : '';
  if (path.length > 500) return null;
  if (path.split('/').some((part) => part === '..' || part === '.')) return null;
  return path;
}

function latestBlocks(blocks: AssistantInput['blocks']): AssistantInput['blocks'] {
  return blocks.filter(
    (b) => !blocks.some((other) => other.key === b.key && other.version > b.version)
  );
}

function catalogue(blocks: AssistantInput['blocks']): string {
  const latest = latestBlocks(blocks);
  if (latest.length === 0) return 'The organization has published no blocks yet.';
  return latest
    .map((b) => {
      const d = b.definition;
      const inputs = d.inputs
        .map((i) => `${i.name}${i.default === undefined ? ' (required)' : `=${i.default}`}`)
        .join(', ');
      const where = d.runsOn.type === 'hosted' ? `image ${d.runsOn.image}` : 'on a target';
      return `- ${b.key} v${b.version} — ${b.name} (${d.kind}, ${where})${inputs ? `; inputs: ${inputs}` : ''}${d.consumes.length ? `; takes ${d.consumes.join(', ')}` : ''}${d.produces.length ? `; leaves ${d.produces.map((p) => p.name).join(', ')}` : ''}${b.description ? `. ${b.description}` : ''}`;
    })
    .join('\n');
}

/** A proposed file's size, and the file's as the model reads it. */
export const MAX_PIPELINE_FILE_CHARS = 60_000;

/** The prompt for a pipeline written by hand: the file is the pipeline, and the answer is the file. */
function filePrompt(input: AssistantInput, file: { name: string; text: string }): string {
  const hostName = HOST_LABEL[input.host];
  const product = input.host === 'github' ? 'GitHub Actions workflow' : 'Bitbucket Pipelines file';
  return [
    `You help a person change the CI/CD pipeline of the branch ${input.branch} of the repository ${input.repo} (on ${hostName}). The branch is assigned to the project's environment "${input.environment}": merges to it are what deploy ${input.environment}.`,
    `Its pipeline is a ${product} written by hand, ${file.name}, open in the page's editor. It was not built from Renkei's building blocks and you do not turn it into them: you edit the file as it is, in ${hostName}'s own syntax, keeping what works and the author's style.`,
    '',
    'Work from the actual source: list and read the files that say how the project builds, tests and runs (package manifests, lockfiles, Dockerfiles, Makefiles, compose files, scripts, other CI files) before changing anything. Do not guess commands the repository does not support.',
    '',
    'Change the file only with propose_file, sending the whole file as it should be — every line, not a fragment or a diff. The person reviews it in the editor and commits it themselves; nothing reaches the repository until they do.',
    'Rules:',
    '- Valid YAML, in the syntax this host runs. Do not invent keys.',
    '- Never write a secret value into the file. Read secrets and variables by name, as the host provides them, and say which ones the person must set (on the Variables tab of this page).',
    `- Keep the file about this branch: what runs on pull requests into ${input.branch}, and what deploys ${input.environment} on a merge to it.`,
    '- A deploy should fail loudly when it did not work.',
    '',
    `The file in the editor now (${file.name}):\n${file.text.slice(0, MAX_PIPELINE_FILE_CHARS) || '(empty)'}`,
    '',
    'Your goal is to fulfil the person’s request in this turn: read what you need, then propose the file that does what they asked. Do not stop to announce a next step; when you would say you will do something next, do it now with a tool call. End your turn only when the request is met, or when you need something only the person can tell you. A question about the file is answered in words, with no proposal.',
    `A proposal that is not usable comes back with what is wrong; after ${MAX_FAILED_PROPOSALS} that are not, the turn ends with nothing proposed.`,
    'Keep replies short: say what you read, what you changed and why, and anything the person must still do.',
  ].join('\n');
}

/** A propose_file call read whole, or what to tell the model. */
export function readFileProposal(
  raw: unknown,
  file: { name: string }
): FileProposal | { problems: string[] } {
  const call = isRecord(raw) ? raw : {};
  const text = typeof call.text === 'string' ? call.text : '';
  if (!text.trim()) return { problems: ['Send the whole file in "text"; it was empty.'] };
  if (text.length > MAX_PIPELINE_FILE_CHARS) {
    return { problems: [`The file is over ${MAX_PIPELINE_FILE_CHARS} characters.`] };
  }
  const parsed = parseDocument(text);
  if (parsed.errors.length > 0) {
    return {
      problems: parsed.errors.slice(0, 5).map((error) => `It is not valid YAML: ${error.message}`),
    };
  }
  if (!isMap(parsed.contents)) {
    return {
      problems: ['A pipeline file is a YAML mapping at its top level; send the whole file.'],
    };
  }
  const summary =
    typeof call.summary === 'string' && call.summary.trim()
      ? call.summary.trim().slice(0, 1000)
      : 'An edited file.';
  return { summary, name: file.name, text: text.endsWith('\n') ? text : `${text}\n` };
}

function systemPrompt(input: AssistantInput): string {
  if (input.file) return filePrompt(input, input.file);
  const hostName = HOST_LABEL[input.host];
  const targets = input.targets
    .map((t) => `${t.name}${t.labels[input.host].length === 0 ? ` (no ${hostName} labels)` : ''}`)
    .join(', ');
  return [
    `You help a person tailor the CI/CD pipeline of the branch ${input.branch} of the repository ${input.repo} (on ${hostName}) in Renkei's pipeline builder. The branch is assigned to the project's environment "${input.environment}".`,
    `The builder writes ${PIPELINE_FILE[input.host]} onto that branch from a pipeline made of building blocks: steps run on every pull request ("checks", nothing deploys), then the steps that deploy ${input.environment} when something merges to ${input.branch}. A pipeline file lives on its branch, so this pipeline is about this branch alone: "environments" always holds exactly one entry, { "name": "${input.environment}", "branch": "${input.branch}", "steps": [...] }. Other environments and branches have pipelines of their own; never add them here. Renkei never deploys; merging starts ${hostName}'s pipeline.`,
    '',
    'Work from the actual source: list and read the files that say how the project builds, tests and runs (package manifests, lockfiles, Dockerfiles, Makefiles, compose files, existing CI files, scripts) before proposing anything. Do not guess commands the repository does not support.',
    '',
    'Change the pipeline only with propose_pipeline, sending the whole pipeline as it should be. Use the organization’s blocks where one fits as it is. Where none fits the project, write a block of the project’s own in "blocks" and use its key in the steps: commands, image, caches and artifacts tailored to this repository. A project block is kept with this project only.',
    'A block definition is:',
    `{ "kind": one of ${BLOCK_KINDS.map((k) => `"${k}"`).join(', ')}, "runsOn": { "type": "hosted", "image": "node:22" } or { "type": "target" }, "inputs": [{ "name": "lower_case", "type": "text"|"number"|"boolean"|"url", "default"?: "...", "description"?: "..." }], "variables": [{ "name": "UPPER_CASE", "secured": true|false, "description"?: "..." }], "consumes": ["artifact"], "produces": [{ "name": "artifact", "paths": ["dist"] }], "caches": [{ "name": "npm", "path": "~/.npm", "keyFiles": ["package-lock.json"] }], "commands": "shell, one command per line" }`,
    'Rules for blocks:',
    '- Commands may use ${commit}, ${branch}, ${repo}, ${env} (deploy blocks only) and ${input.NAME} for a declared input. Never use a host’s own variables such as $BITBUCKET_COMMIT or $GITHUB_SHA.',
    '- Read variables and secrets as $NAME and declare each in "variables" (secured for anything secret). Never write a secret value into a block. Names may not start with BITBUCKET_, GITHUB_, RUNNER_ or RENKEI_.',
    '- Do not check out the repository or upload artifacts yourself: "consumes" and "produces" do that. A step that needs an artifact must come after one that leaves it, in the same row.',
    '- "hosted" runs in a public image on the host’s runners; "target" runs on the organization’s self-hosted machines, and the step names the target. Deploys to the organization’s own machines run on a target.',
    '- A deploy should fail loudly when it did not work (a health check, an exit code).',
    'A step is { "block": key, "version": n, "inputs": { name: value }, "target"?: target name }. Fill in every required input.',
    '',
    `The organization’s blocks:\n${catalogue(input.blocks)}`,
    `Targets: ${targets || 'none yet (an operator adds them under Targets)'}.`,
    '',
    `The pipeline in the builder now (JSON):\n${JSON.stringify(input.spec)}`,
    ...(input.specProblems && input.specProblems.length > 0
      ? [
          `It does not read yet, so it cannot be saved:\n${input.specProblems.map((p) => `- ${p}`).join('\n')}\nWhatever the person asks, your proposal must fix these; say what you changed.`,
        ]
      : []),
    '',
    input.operator
      ? 'The person is an operator. When they ask to reuse a block in other projects, call propose_building_block with a general version of it: values only this project has (service names, paths, ports, URLs, image tags) become inputs, with this project’s value as the default only when it is a sensible default for others. Choose a key no organization block has.'
      : 'Only operators add blocks to the organization’s catalogue; if asked, say so.',
    '',
    'Your goal is to fulfil the person’s request in this turn: read what you need, then propose the change that does what they asked. Do not stop to announce a next step or to ask whether to go on; when you would say you will do something next (read a file, propose the pipeline), do it now with a tool call. End your turn only when the request is met, or when you need something only the person can tell you.',
    `A proposal that does not read comes back with what is wrong; after ${MAX_FAILED_PROPOSALS} that do not, the turn ends with nothing proposed, so check each one against the rules before you send it. Keep descriptions in a proposal to a few words so it fits in one reply.`,
    'Keep replies short: say what you read, what you changed and why, and anything the person must still do (a variable to set, a target to pick). The person reviews and applies a proposal; nothing is saved until they do.',
  ].join('\n');
}

/** The tools for a pipeline written by hand: reading the repository, and proposing the file. */
function fileTools(): LlmToolDef[] {
  return [
    ...tools(false).filter((tool) => tool.name === 'list_files' || tool.name === 'read_file'),
    {
      name: 'propose_file',
      description:
        'Propose the whole pipeline file as it should be. The person reviews it in the editor and commits it.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One or two sentences: what changes and why.' },
          text: { type: 'string', description: 'The whole file, every line.' },
        },
        required: ['summary', 'text'],
      },
    },
  ];
}

function tools(operator: boolean): LlmToolDef[] {
  const definition = { type: 'object', description: 'A block definition, as described.' };
  const list: LlmToolDef[] = [
    {
      name: 'list_files',
      description: 'List one directory of the repository on the pipeline’s branch.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative; empty for the top level.' } },
      },
    },
    {
      name: 'read_file',
      description: 'Read one text file of the repository on the pipeline’s branch.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    {
      name: 'propose_pipeline',
      description:
        'Propose the whole pipeline as it should be, with any blocks of the project’s own. The person reviews and applies it.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One or two sentences: what changes and why.' },
          checks: { type: 'array', items: { type: 'object' } },
          environments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                branch: { type: 'string' },
                steps: { type: 'array', items: { type: 'object' } },
              },
            },
          },
          blocks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                name: { type: 'string' },
                description: { type: 'string' },
                version: { type: 'number' },
                definition,
              },
            },
          },
        },
        required: ['summary', 'checks', 'environments'],
      },
    },
  ];
  if (operator) {
    list.push({
      name: 'propose_building_block',
      description:
        'Propose a building block for the organization’s catalogue, made general from one of this project’s blocks. The operator saves it as a draft to review and publish.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'The project block’s key it is made from.' },
          key: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          definition,
        },
        required: ['key', 'name', 'description', 'definition'],
      },
    });
  }
  return list;
}

type ToolOutcome = { content: string; isError?: boolean };

/** A propose_pipeline call read whole, or what to tell the model. */
export function readPipelineProposal(
  raw: unknown,
  input: Pick<AssistantInput, 'host' | 'blocks' | 'targets'> &
    Partial<Pick<AssistantInput, 'environment' | 'branch'>>
): PipelineProposal | { problems: string[] } {
  const call = isRecord(raw) ? raw : {};
  const read = readPipelineSpec({
    checks: call.checks,
    environments: call.environments,
    blocks: call.blocks,
  });
  if (!read.ok) return { problems: read.errors };
  const spec = read.value;
  if (input.environment !== undefined && input.branch !== undefined) {
    const [only, ...others] = spec.environments;
    if (
      !only ||
      others.length > 0 ||
      only.branch !== input.branch ||
      only.name.toLowerCase() !== input.environment.toLowerCase()
    ) {
      return {
        problems: [
          `This pipeline is the branch ${input.branch}’s alone: "environments" must hold exactly one entry, named ${input.environment} with branch ${input.branch}.`,
        ],
      };
    }
  }
  const organization = (key: string, version: number) =>
    input.blocks.find((b) => b.key === key && b.version === version) ?? null;
  const blockAt = blockOfStep(spec, organization);
  const problems: string[] = [];
  const steps = [
    ...spec.checks.map((s, i) => ({ s, where: `Pull requests, step ${i + 1}` })),
    ...spec.environments.flatMap((e) =>
      e.steps.map((s, i) => ({ s, where: `${e.name}, step ${i + 1}` }))
    ),
  ];
  for (const { s, where } of steps) {
    const block = blockAt(s.block, s.version);
    if (!block) {
      const known = input.blocks.filter((b) => b.key === s.block).map((b) => `v${b.version}`);
      problems.push(
        known.length > 0
          ? `${where}: ${s.block} has ${known.join(', ')}, not v${s.version}.`
          : `${where}: there is no block ${s.block}; use an organization block or add one to "blocks".`
      );
    } else if (where.startsWith('Pull requests') && block.definition.kind === 'deploy') {
      problems.push(
        `${where}: nothing deploys on a pull request; move ${s.block} to an environment.`
      );
    }
  }
  for (const own of spec.blocks ?? []) {
    if (!steps.some(({ s }) => s.block === own.key)) {
      problems.push(`The block ${own.key} is not used by any step; use it or leave it out.`);
    }
  }
  if (problems.length > 0) return { problems };
  const rendered = renderPipeline(spec, {
    host: input.host,
    block: organization,
    target: (name) => input.targets.find((t) => t.name === name)?.labels ?? null,
  });
  const summary =
    typeof call.summary === 'string' && call.summary.trim()
      ? call.summary.trim().slice(0, 1000)
      : 'A tailored pipeline.';
  return { summary, spec, unfinished: rendered.ok ? [] : rendered.errors };
}

/** A propose_building_block call read whole, or what to tell the model. */
export function readBuildingBlockProposal(
  raw: unknown,
  organizationKeys: string[]
): BuildingBlockProposal | { problems: string[] } {
  const call = isRecord(raw) ? raw : {};
  const problems: string[] = [];
  const key = typeof call.key === 'string' ? call.key.trim() : '';
  if (!BLOCK_KEY.test(key)) {
    problems.push('The key must be lower case letters, digits and -, starting with a letter.');
  } else if (organizationKeys.includes(key)) {
    problems.push(`The organization has a block keyed ${key}; choose another key.`);
  }
  const name = typeof call.name === 'string' ? call.name.trim().slice(0, 200) : '';
  if (!name) problems.push('Give the block a name.');
  const definition = readBlockDefinition(call.definition);
  if (!definition.ok) problems.push(...definition.errors);
  if (problems.length > 0 || !definition.ok) return { problems };
  return {
    key,
    name,
    description: typeof call.description === 'string' ? call.description.trim().slice(0, 1000) : '',
    kind: definition.value.kind,
    definition: definition.value,
    from: typeof call.from === 'string' && call.from.trim() ? call.from.trim() : null,
  };
}

export function assistantError(kind: LlmErrorKind): string {
  if (kind === 'auth')
    return 'The model rejected the organization’s API key; an admin can check it under Agent models.';
  if (kind === 'rate_limit' || kind === 'overloaded')
    return 'The model is rate-limiting right now; try again in a minute.';
  if (kind === 'timeout' || kind === 'network')
    return 'The model did not answer in time; try again.';
  if (kind === 'context_length')
    return 'The conversation grew too long for the model; start a new one.';
  return `The model failed (${kind}); try again.`;
}

/** The reply when its proposals kept failing to read: what was wrong with the last. */
export function gaveUp(problems: string[], kept: boolean): string {
  return [
    kept
      ? `${MAX_FAILED_PROPOSALS} of my proposals did not read, so I stopped; below is the last one that did. The last that failed was refused because:`
      : `I could not make a proposal that reads in ${MAX_FAILED_PROPOSALS} tries, so nothing is proposed. The last one was refused because:`,
    ...problems.map((p) => `- ${p}`),
    'Ask again, perhaps for a smaller change, and I will start from there.',
  ].join('\n');
}

const textOf = (content: LlmContentBlock[]) =>
  content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();

/**
 * One turn of the conversation: the model reads what it needs and
 * proposes, a tool round trip at a time, until it answers in words.
 */
export async function runPipelineAssistant(
  input: AssistantInput,
  deps: AssistantDeps
): Promise<AssistantReply | { error: string }> {
  const messages: LlmMessage[] = input.conversation.map((turn) => ({
    role: turn.role,
    content: [{ type: 'text', text: turn.text }],
  }));
  const read: string[] = [];
  let reads = 0;
  let proposal: PipelineProposal | null = null;
  let buildingBlock: BuildingBlockProposal | null = null;
  let file: FileProposal | null = null;
  const said: string[] = [];
  const organizationKeys = [...new Set(input.blocks.map((b) => b.key))];

  let listings = 0;
  /** What was wrong with each proposal that did not read, in order. */
  const failures: string[][] = [];
  const run = async (name: string, raw: unknown): Promise<ToolOutcome> => {
    const args = isRecord(raw) ? raw : {};
    if (name === 'list_files') {
      const path = cleanPath(args.path ?? '');
      if (path === null) return { content: 'That is not a path in the repository.', isError: true };
      if (listings >= MAX_LISTINGS) {
        return {
          content: `That is ${MAX_LISTINGS} directories already; propose from what you have seen.`,
          isError: true,
        };
      }
      listings += 1;
      read.push(path ? `${path}/` : '/');
      await deps.onStep?.(`Looking in ${path ? `${path}/` : 'the repository'}`);
      const listed = await deps.listFiles(path);
      if (!listed.ok) return { content: listed.error, isError: true };
      const lines = listed.entries
        .slice(0, MAX_LISTED)
        .map((e) => (e.kind === 'dir' ? `${e.path}/` : e.path));
      if (listed.entries.length > MAX_LISTED)
        lines.push(`… and ${listed.entries.length - MAX_LISTED} more`);
      return { content: lines.join('\n') || '(empty)' };
    }
    if (name === 'read_file') {
      const path = cleanPath(args.path);
      if (!path) return { content: 'Name a file in the repository.', isError: true };
      if (reads >= MAX_FILE_READS) {
        return {
          content: `That is ${MAX_FILE_READS} files already; propose from what you have read.`,
          isError: true,
        };
      }
      reads += 1;
      read.push(path);
      await deps.onStep?.(`Reading ${path}`);
      const file = await deps.readFile(path);
      if (!file.ok) return { content: file.error, isError: true };
      if (file.binary) return { content: 'That file is not text.' };
      const cut = file.truncated || file.text.length > MAX_FILE_CHARS;
      return {
        content: `${file.text.slice(0, MAX_FILE_CHARS)}${cut ? '\n… (the rest is cut)' : ''}`,
      };
    }
    if (name === 'propose_file' && input.file) {
      await deps.onStep?.('Checking the file it proposes');
      const outcome = readFileProposal(raw, input.file);
      if ('problems' in outcome) {
        failures.push(outcome.problems);
        return {
          content: `The file cannot be used yet:\n${outcome.problems.map((p) => `- ${p}`).join('\n')}\nCall propose_file again with the whole corrected file.`,
          isError: true,
        };
      }
      file = outcome;
      return { content: 'Proposed. The person reviews it in the editor and commits it.' };
    }
    if (name === 'propose_pipeline' && !input.file) {
      await deps.onStep?.('Checking the pipeline it proposes');
      const outcome = readPipelineProposal(raw, input);
      if ('problems' in outcome) {
        failures.push(outcome.problems);
        return {
          content: `The pipeline cannot be used yet:\n${outcome.problems.map((p) => `- ${p}`).join('\n')}\nCall propose_pipeline again with the whole corrected pipeline.`,
          isError: true,
        };
      }
      proposal = outcome;
      return {
        content:
          outcome.unfinished.length > 0
            ? `Proposed. The person reviews it. Still to do before the file can be written:\n${outcome.unfinished.map((p) => `- ${p}`).join('\n')}`
            : 'Proposed. The person reviews it; the file can be written as it is.',
      };
    }
    if (name === 'propose_building_block' && input.operator) {
      await deps.onStep?.('Checking the building block it proposes');
      const outcome = readBuildingBlockProposal(raw, organizationKeys);
      if ('problems' in outcome) {
        failures.push(outcome.problems);
        return {
          content: `The block cannot be used yet:\n${outcome.problems.map((p) => `- ${p}`).join('\n')}\nCall propose_building_block again with the whole corrected block.`,
          isError: true,
        };
      }
      buildingBlock = outcome;
      return {
        content: 'Proposed. The operator saves it as a draft, then reviews and publishes it.',
      };
    }
    return { content: `There is no tool ${name}.`, isError: true };
  };

  // The turn goes on until the model answers in words. The reading budget
  // (MAX_FILE_READS, MAX_LISTINGS) makes it propose; MAX_FAILED_PROPOSALS
  // stops a model that cannot make one read; MAX_ROUNDS is the backstop.
  // `finished` is false when it ran out of rounds or was cut off with
  // nothing said, so its last words are not taken as the answer.
  let finished = false;
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    await deps.onStep?.(round === 1 ? 'Thinking it over' : 'Thinking over what it found');
    const completion = await deps.complete({
      system: systemPrompt(input),
      messages,
      tools: input.file ? fileTools() : tools(input.operator),
      maxTokens: Math.min(MAX_OUTPUT_TOKENS, deps.maxOutputTokens),
      timeoutMs: TIMEOUT_MS,
      promptCache: true,
    });
    if (!completion.ok) return { error: assistantError(completion.err.type) };
    const content = completion.val.content;
    const text = textOf(content);
    if (text) said.push(text);
    const calls = content.filter(
      (block): block is Extract<LlmContentBlock, { type: 'tool_use' }> => block.type === 'tool_use'
    );
    const cutOff = completion.val.stopReason === 'max_tokens';
    if (calls.length === 0) {
      finished = !cutOff || text.length > 0;
      break;
    }
    if (!cutOff && completion.val.stopReason !== 'tool_use') {
      finished = true;
      break;
    }
    messages.push({ role: 'assistant', content });
    const results: LlmContentBlock[] = [];
    for (const call of calls) {
      // A call cut off at the output limit carries a partial input: never
      // run it, tell the model to send it again, smaller.
      if (cutOff && call.name.startsWith('propose_')) {
        failures.push(['It was cut off at the model’s reply limit before it was complete.']);
      }
      const outcome: ToolOutcome = cutOff
        ? {
            content:
              'Your reply reached the output limit before this call was complete, so it was not used. Send it again, whole and more compact: short descriptions, no repeated text.',
            isError: true,
          }
        : await run(call.name, call.input);
      results.push({
        type: 'tool_result',
        toolUseId: call.id,
        content: outcome.content,
        ...(outcome.isError ? { isError: true } : {}),
      });
    }
    if (failures.length >= MAX_FAILED_PROPOSALS) {
      const kept = proposal !== null || buildingBlock !== null || file !== null;
      return {
        reply: gaveUp(failures[failures.length - 1], kept),
        proposal,
        buildingBlock,
        ...(input.file ? { file } : {}),
        read,
      };
    }
    messages.push({ role: 'user', content: results });
  }

  const proposed = proposal !== null || buildingBlock !== null || file !== null;
  const last = said[said.length - 1];
  const reply = finished
    ? (last ?? (proposed ? 'Here is what I propose.' : UNFINISHED))
    : proposed
      ? `${last ?? 'Here is what I propose.'}\n\n${UNFINISHED_AFTER_PROPOSING}`
      : UNFINISHED;
  return { reply, proposal, buildingBlock, ...(input.file ? { file } : {}), read };
}
