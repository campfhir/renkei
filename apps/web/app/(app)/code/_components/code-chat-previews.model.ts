/**
 * The previews a code chat's title bar knows about — the project's own
 * servers the chat (or a person) started, served through the app — and
 * what the overflow menu offers for them: one "Open preview" item per
 * preview that is up, opening its address in a new tab, none for one
 * that exited. Read again with the checkout's counts when a turn ends,
 * since that is when a chat starts or stops one. code-chat-tools.tsx
 * fetches and dispatches; tested in code-chat-previews.model.test.ts.
 */

export interface PreviewEntry {
  name: string;
  status: 'starting' | 'running' | 'exited';
  /** The address a signed-in member opens. */
  url: string;
  /** The share link, when the preview is public. */
  publicUrl: string | null;
}

export interface CodeChatPreviewsState {
  previews: PreviewEntry[];
}

export type CodeChatPreviewsAction =
  /** The list as the server answered it; an unreadable answer leaves the menu empty. */
  { type: 'loaded'; previews: PreviewEntry[] } | { type: 'cleared' };

export const initialCodeChatPreviews: CodeChatPreviewsState = { previews: [] };

export function codeChatPreviewsReducer(
  state: CodeChatPreviewsState,
  action: CodeChatPreviewsAction
): CodeChatPreviewsState {
  switch (action.type) {
    case 'loaded':
      return { previews: action.previews };
    case 'cleared':
      return state.previews.length ? { previews: [] } : state;
  }
}

/** What the server's `previews` answer becomes; anything not in shape is left out. */
export function previewEntriesOf(value: unknown): PreviewEntry[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const record: { previews?: unknown } = value;
  if (!Array.isArray(record.previews)) return [];
  const entries: PreviewEntry[] = [];
  for (const raw of record.previews) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item: { name?: unknown; status?: unknown; url?: unknown; publicUrl?: unknown } = raw;
    if (typeof item.name !== 'string' || typeof item.url !== 'string') continue;
    const status =
      item.status === 'starting' || item.status === 'running' || item.status === 'exited'
        ? item.status
        : 'exited';
    entries.push({
      name: item.name,
      status,
      url: item.url,
      publicUrl: typeof item.publicUrl === 'string' ? item.publicUrl : null,
    });
  }
  return entries;
}

export interface PreviewMenuItem {
  label: string;
  url: string;
}

/** The menu's items: one per preview that is up, named; none when nothing is. */
export function previewMenuItems(state: CodeChatPreviewsState): PreviewMenuItem[] {
  const up = state.previews.filter((preview) => preview.status !== 'exited');
  return up.map((preview) => ({
    label: up.length === 1 ? 'Open preview' : `Open preview: ${preview.name}`,
    url: preview.url,
  }));
}
