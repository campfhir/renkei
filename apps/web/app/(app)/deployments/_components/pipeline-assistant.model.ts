/**
 * The pipeline builder's assistant panel (pipeline-assistant.tsx): the
 * conversation, what each answer proposes, applying a proposal to the
 * builder, and — for an operator — saving a building block the assistant
 * made from one of the project's blocks as a draft in the organization's
 * catalogue. Tested in pipeline-assistant.model.test.ts.
 *
 * The conversation lives on the page only; each question sends it whole
 * with the pipeline as the builder has it now
 * (POST …/pipeline-builder/assistant), so the assistant always works from
 * what is on screen, applied or not. The server answers with a job and
 * works the answer out in the background; the page follows the job
 * (GET …/assistant/[jobId]), showing each step, until it ends.
 */

import type { BlockDefinition, BlockKind, PipelineSpec } from '@renkei/ci-blocks';

/** What POST …/pipeline-builder/assistant answers. */
export interface AssistantAnswer {
  reply: string;
  proposal: { summary: string; spec: PipelineSpec; unfinished: string[] } | null;
  buildingBlock: {
    key: string;
    name: string;
    description: string;
    kind: BlockKind;
    definition: BlockDefinition;
    from: string | null;
  } | null;
  read: string[];
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  proposal?: AssistantAnswer['proposal'];
  buildingBlock?: AssistantAnswer['buildingBlock'];
  read?: string[];
}

export interface AssistantState {
  messages: AssistantMessage[];
  draft: string;
  busy: boolean;
  /** The question being worked out on the server (…/assistant/[jobId]), while busy. */
  job: string | null;
  /** What the assistant is doing now ("Reading package.json"), while busy. */
  step: string | null;
  error: string | null;
  /** What the refusal named, each in its words. */
  problems: string[];
  /** Messages whose proposal the person applied. */
  applied: string[];
  /** The message whose building block is being saved. */
  saving: string | null;
  /** The catalogue's id of each saved building block, by message. */
  saved: Record<string, string>;
  /** Why a building block was not saved, by message. */
  blockErrors: Record<string, string>;
}

export type AssistantAction =
  | { type: 'draft'; text: string }
  /** The person asked; `text` is the draft unless a button asked for them. */
  | { type: 'asked'; id: string; text: string }
  /** The server took the question as this job; its answer comes later. */
  | { type: 'started'; job: string }
  | { type: 'progressed'; job: string; step: string | null }
  /** `job` names the question answered; an answer to one given up on is dropped. */
  | { type: 'answered'; id: string; answer: AssistantAnswer; job?: string }
  | { type: 'failed'; error: string; problems?: string[]; job?: string }
  | { type: 'applied'; id: string }
  | { type: 'savingBlock'; id: string }
  | { type: 'blockSaved'; id: string; blockId: string }
  | { type: 'blockFailed'; id: string; error: string }
  | { type: 'reset' };

export const initialAssistant: AssistantState = {
  messages: [],
  draft: '',
  busy: false,
  job: null,
  step: null,
  error: null,
  problems: [],
  applied: [],
  saving: null,
  saved: {},
  blockErrors: {},
};

export const MAX_QUESTION_CHARS = 4_000;

export function assistantReducer(state: AssistantState, action: AssistantAction): AssistantState {
  switch (action.type) {
    case 'draft':
      return { ...state, draft: action.text.slice(0, MAX_QUESTION_CHARS) };
    case 'asked': {
      const text = action.text.trim();
      if (!text || state.busy) return state;
      return {
        ...state,
        messages: [...state.messages, { id: action.id, role: 'user', text }],
        draft: text === state.draft.trim() ? '' : state.draft,
        busy: true,
        job: null,
        step: null,
        error: null,
        problems: [],
      };
    }
    case 'started':
      return state.busy ? { ...state, job: action.job, step: null } : state;
    case 'progressed':
      return state.busy && state.job === action.job ? { ...state, step: action.step } : state;
    case 'answered':
      if (!state.busy || (action.job !== undefined && action.job !== state.job)) return state;
      return {
        ...state,
        busy: false,
        job: null,
        step: null,
        messages: [
          ...state.messages,
          {
            id: action.id,
            role: 'assistant',
            text: action.answer.reply,
            proposal: action.answer.proposal,
            buildingBlock: action.answer.buildingBlock,
            read: action.answer.read,
          },
        ],
      };
    case 'failed': {
      if (!state.busy || (action.job !== undefined && action.job !== state.job)) return state;
      // The question stays in the box to send again; it leaves the thread.
      const last = state.messages[state.messages.length - 1];
      const unanswered = last?.role === 'user' ? last : null;
      return {
        ...state,
        busy: false,
        job: null,
        step: null,
        error: action.error,
        problems: action.problems ?? [],
        messages: unanswered ? state.messages.slice(0, -1) : state.messages,
        draft: unanswered && !state.draft.trim() ? unanswered.text : state.draft,
      };
    }
    case 'applied':
      return state.applied.includes(action.id)
        ? state
        : { ...state, applied: [...state.applied, action.id] };
    case 'savingBlock': {
      const { [action.id]: _gone, ...blockErrors } = state.blockErrors;
      return { ...state, saving: action.id, blockErrors };
    }
    case 'blockSaved':
      return { ...state, saving: null, saved: { ...state.saved, [action.id]: action.blockId } };
    case 'blockFailed':
      return {
        ...state,
        saving: null,
        blockErrors: { ...state.blockErrors, [action.id]: action.error },
      };
    case 'reset':
      return initialAssistant;
  }
}

export function canAsk(state: AssistantState): boolean {
  return !state.busy && state.draft.trim().length > 0;
}

/**
 * What a question sends: the conversation in words — an answer's proposal
 * noted with whether the person applied it — and the pipeline on screen.
 */
export function askRequest(
  state: AssistantState,
  spec: PipelineSpec
): { conversation: { role: 'user' | 'assistant'; text: string }[]; spec: PipelineSpec } {
  return {
    conversation: state.messages.map((m) => {
      const notes = [
        m.proposal
          ? `(I proposed: ${m.proposal.summary} The person ${state.applied.includes(m.id) ? 'applied it' : 'has not applied it'}.)`
          : '',
        m.buildingBlock
          ? `(I proposed the building block ${m.buildingBlock.key}; ${state.saved[m.id] ? 'it was saved as a draft' : 'it is not saved'}.)`
          : '',
      ].filter(Boolean);
      return { role: m.role, text: [m.text, ...notes].join('\n\n') };
    }),
    spec,
  };
}

/** The question the "Make it reusable" button asks about one of the project's blocks. */
export function reuseQuestion(block: { key: string; name: string }): string {
  return `Turn the project’s block “${block.name}” (${block.key}) into a building block other projects can reuse.`;
}

/** The catalogue's create body (POST /api/admin/ci-blocks) for a message's building block. */
export function buildingBlockRequest(
  state: AssistantState,
  id: string
): {
  key: string;
  name: string;
  description: string | null;
  kind: BlockKind;
  definition: BlockDefinition;
} | null {
  const block = state.messages.find((m) => m.id === id)?.buildingBlock;
  if (!block) return null;
  return {
    key: block.key,
    name: block.name,
    description: block.description || null,
    kind: block.kind,
    definition: block.definition,
  };
}

export interface ProposalCard {
  summary: string;
  /** “Pull requests: Node: test → Build billing”, one line a row. */
  rows: string[];
  /** The project's own blocks it adds or changes, by name. */
  ownBlocks: { key: string; name: string; description: string | null; isNew: boolean }[];
  unfinished: string[];
  applied: boolean;
}

/** An answer's proposal as the panel shows it, against the pipeline on screen. */
export function proposalCard(
  state: AssistantState,
  message: AssistantMessage,
  current: PipelineSpec | null,
  blockName: (key: string) => string
): ProposalCard | null {
  const proposal = message.proposal;
  if (!proposal) return null;
  const spec = proposal.spec;
  const name = (key: string) => spec.blocks?.find((b) => b.key === key)?.name ?? blockName(key);
  const row = (steps: PipelineSpec['checks']) =>
    steps.length > 0 ? steps.map((s) => name(s.block)).join(' → ') : 'nothing';
  return {
    summary: proposal.summary,
    rows: [
      `Pull requests: ${row(spec.checks)}`,
      ...spec.environments.map((e) => `${e.name} (on merge to ${e.branch}): ${row(e.steps)}`),
    ],
    ownBlocks: (spec.blocks ?? [])
      .filter((b) => {
        const before = current?.blocks?.find((c) => c.key === b.key);
        return !before || JSON.stringify(before) !== JSON.stringify(b);
      })
      .map((b) => ({
        key: b.key,
        name: b.name,
        description: b.description ?? null,
        isNew: !current?.blocks?.some((c) => c.key === b.key),
      })),
    unfinished: proposal.unfinished,
    applied: state.applied.includes(message.id),
  };
}
