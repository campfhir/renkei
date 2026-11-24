/**
 * The Building blocks list (blocks-list.tsx): the catalogue as loaded, the
 * kind and words it is narrowed to, and how each row reads — its kind,
 * where it runs, what it needs, its version. Tested in
 * blocks-list.model.test.ts.
 */

import { BLOCK_KINDS, type BlockKind } from '@renkei/ci-blocks';
import { KIND_LABELS } from './block-editor.model';

/** What GET /api/admin/ci-blocks answers per block. */
export interface BlockSummaryView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  kind: string;
  latestVersion: number;
  hasDraft: boolean;
  runsOn: 'hosted' | 'target' | null;
  image: string | null;
  needs: string[];
  updatedAt: string;
}

export interface BlocksListState {
  blocks: BlockSummaryView[] | null;
  error: string | null;
  kind: BlockKind | 'all';
  query: string;
}

export type BlocksListAction =
  | { type: 'loaded'; blocks: BlockSummaryView[] }
  | { type: 'loadFailed'; error: string }
  | { type: 'kind'; kind: BlockKind | 'all' }
  | { type: 'query'; query: string };

export const initialBlocksList: BlocksListState = {
  blocks: null,
  error: null,
  kind: 'all',
  query: '',
};

export function blocksListReducer(
  state: BlocksListState,
  action: BlocksListAction
): BlocksListState {
  switch (action.type) {
    case 'loaded':
      return { ...state, blocks: action.blocks, error: null };
    case 'loadFailed':
      return { ...state, error: action.error };
    case 'kind':
      return { ...state, kind: action.kind };
    case 'query':
      return { ...state, query: action.query };
  }
}

export const KIND_FILTERS: { kind: BlockKind | 'all'; label: string }[] = [
  { kind: 'all', label: 'All' },
  ...BLOCK_KINDS.map((kind) => ({ kind, label: KIND_LABELS[kind] })),
];

export interface BlockRow {
  id: string;
  name: string;
  about: string;
  kind: string;
  runsOn: string;
  needs: string;
  version: string;
}

function rowOf(block: BlockSummaryView): BlockRow {
  const kind = BLOCK_KINDS.find((k) => k === block.kind);
  return {
    id: block.id,
    name: block.name,
    about: block.description ?? block.key,
    kind: kind ? KIND_LABELS[kind] : block.kind,
    runsOn:
      block.runsOn === 'target'
        ? 'A target a pipeline picks'
        : block.runsOn === 'hosted'
          ? `Hosted runner · ${block.image ?? 'no image'}`
          : '—',
    needs: block.needs.length > 0 ? block.needs.join(', ') : '—',
    version:
      block.latestVersion === 0
        ? 'Draft'
        : `v${block.latestVersion}${block.hasDraft ? ' · unpublished changes' : ''}`,
  };
}

/** The rows shown: the kind picked, then the words, in the name, description or key. */
export function visibleRows(state: BlocksListState): BlockRow[] {
  const words = state.query.trim().toLowerCase();
  return (state.blocks ?? [])
    .filter((block) => state.kind === 'all' || block.kind === state.kind)
    .filter(
      (block) =>
        !words ||
        [block.name, block.description ?? '', block.key].some((field) =>
          field.toLowerCase().includes(words)
        )
    )
    .map(rowOf);
}

/** What the list says when nothing shows. */
export function emptyLine(state: BlocksListState): string | null {
  if (state.blocks === null || visibleRows(state).length > 0) return null;
  if (state.blocks.length === 0) return 'No building blocks yet. Start one, or draft one with AI.';
  return 'No block matches.';
}
