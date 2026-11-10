/**
 * What the top-bar search decides (omni-search.tsx), with no DOM, timers or
 * network: what the box holds and whether its results are showing, which
 * results a query finds and in what sections and order (chats by title
 * first, then by what was said; artifacts by their digest; projects;
 * pages; organization settings, connectors and settings down to the
 * element), which result the arrows have picked, what Enter opens, what
 * Escape clears, and that a slow answer for an older query never shows
 * under a newer one.
 *
 * The component keeps the focus, the debounce, the calls and the scroll to
 * a `#hash` target, and dispatches each outcome here. The places in the app
 * (lib/app-index.ts) are matched by the component and handed in, with the
 * icons, so this module draws nothing. Tested in omni-search.model.test.ts.
 */

import type { LibraryItem } from '@/lib/chat/artifact-library';
import type { ProjectListItem } from '@/lib/chat/sidebar';
import { CHAT_SEARCH_MIN_CHARS, normalizeQuery } from '@/lib/chat/search-text';
import type { ChatListItem } from '@/lib/chat/views';

/** A place in the app's menu, from the menu's own list so the two agree. */
export interface OmniPage {
  label: string;
  href: string;
  icon: string;
}

/** A setting, connector or organization setting (lib/app-index.ts's AppPlace). */
export interface OmniPlace {
  title: string;
  where: string;
  href: string;
  icon: string;
  section: 'Settings' | 'Connectors' | 'Organization';
}

export interface Result {
  href: string;
  label: string;
  /** A second line: the project a chat sits in, or the line it was found by. */
  detail?: string;
  icon: string;
}

export interface Section {
  title: string;
  results: Result[];
}

/** The icon paths for results that are not pages or places. */
export interface ResultIcons {
  chat: string;
  pages: string;
  code: string;
  artifact: string;
}

/** What a found artifact's row is drawn from. */
export type OmniArtifact = Pick<LibraryItem, 'id' | 'filename' | 'summary' | 'chat'>;

/** What a project's row is drawn from: a code project has a repository, a chat project none. */
export type OmniProject = Pick<ProjectListItem, 'id' | 'name' | 'repoFullName'>;

export const LIMITS = { pages: 6, places: 6, projects: 5, artifacts: 5, chats: 8 };

// ── State ───────────────────────────────────────────────────────────────

export interface OmniState {
  query: string;
  open: boolean;
  active: number;
  /** On a phone the field is folded into a magnifier button until asked for. */
  expanded: boolean;
  /** The whole history, once fetched; until then the menu's recent window stands in. */
  allChats: ChatListItem[] | null;
  /** What was said, by chat, for the text it was asked for. */
  said: { query: string; hits: Map<string, string> };
  /** Artifacts the library found, for the text it was asked for. */
  found: { query: string; items: OmniArtifact[] };
}

export type OmniAction =
  /** The field took focus, or Ctrl/⌘K moved it there. */
  | { type: 'focus' }
  /** The magnifier on a phone. */
  | { type: 'magnifier' }
  | { type: 'type'; value: string }
  /** An arrow key over a list of `count` results. */
  | { type: 'move'; delta: 1 | -1; count: number }
  | { type: 'hover'; index: number }
  | { type: 'escape' }
  /** The close button, a result chosen: empty, closed, folded. */
  | { type: 'close' }
  /** A click outside. */
  | { type: 'dismiss' }
  /** The page changed under the box. */
  | { type: 'navigated' }
  | { type: 'all-chats'; chats: ChatListItem[] }
  | { type: 'said'; query: string; hits: { chatId: string; snippet: string }[] }
  | { type: 'found'; query: string; items: OmniArtifact[] };

export const initialOmni: OmniState = {
  query: '',
  open: false,
  active: 0,
  expanded: false,
  allChats: null,
  said: { query: '', hits: new Map() },
  found: { query: '', items: [] },
};

export function omniReducer(state: OmniState, action: OmniAction): OmniState {
  switch (action.type) {
    case 'focus':
      return { ...state, open: true };
    case 'magnifier':
      return { ...state, open: true, expanded: true };
    case 'type':
      return { ...state, query: action.value, open: true, active: 0 };
    case 'move': {
      if (!action.count) return { ...state, active: 0 };
      return { ...state, active: (state.active + action.delta + action.count) % action.count };
    }
    case 'hover':
      return { ...state, active: action.index };
    case 'escape':
      // Escape clears the text first; with nothing typed it folds the box away.
      return state.query
        ? { ...state, query: '', open: false }
        : { ...state, query: '', open: false, expanded: false };
    case 'close':
    case 'navigated':
      return { ...state, query: '', open: false, expanded: false };
    case 'dismiss':
      return { ...state, open: false };
    case 'all-chats':
      return { ...state, allChats: action.chats };
    case 'said':
      return {
        ...state,
        said: {
          query: action.query,
          hits: new Map(action.hits.map((hit) => [hit.chatId, hit.snippet])),
        },
      };
    case 'found':
      return { ...state, found: { query: action.query, items: action.items } };
  }
}

// ── Selectors ───────────────────────────────────────────────────────────

/** The query as it is matched and sent: trimmed, folded, spaces collapsed. */
export function queryText(state: Pick<OmniState, 'query'>): string {
  return normalizeQuery(state.query);
}

/** Whether the box holds enough to ask the server what was said and which artifacts hold it. */
export function isSearchable(text: string): boolean {
  return text.length >= CHAT_SEARCH_MIN_CHARS;
}

/** The lines found for the text in the box now; an answer for older text counts for nothing. */
export function currentHits(state: OmniState): Map<string, string> {
  return state.said.query === queryText(state) ? state.said.hits : new Map();
}

export function currentArtifacts(state: OmniState): OmniArtifact[] {
  return state.found.query === queryText(state) ? state.found.items : [];
}

/** Still waiting on what was said for this text: "Searching…" rather than "Nothing matches". */
export function saidPending(state: OmniState): boolean {
  const text = queryText(state);
  return isSearchable(text) && state.said.query !== text;
}

export function showing(state: OmniState): boolean {
  return state.open && queryText(state).length > 0;
}

/** The result the arrows have picked, held inside the list as it shrinks. */
export function currentIndex(state: OmniState, count: number): number {
  return Math.min(state.active, Math.max(count - 1, 0));
}

/** What Enter opens: the picked result's address, if there is one. */
export function enterTarget(state: OmniState, flat: readonly Result[]): string | null {
  return flat[currentIndex(state, flat.length)]?.href ?? null;
}

/** The same address with the search's words added, so the page can use them. */
export function withFind(href: string, query: string): string {
  const [path, hash] = href.split('#');
  const search = new URLSearchParams({ find: query }).toString();
  return `${path}?${search}${hash ? `#${hash}` : ''}`;
}

export interface SectionInput {
  /** The normalized query (`queryText`). */
  query: string;
  artifacts: readonly OmniArtifact[];
  pages: readonly OmniPage[];
  projects: readonly OmniProject[];
  chats: readonly ChatListItem[];
  hits: ReadonlyMap<string, string>;
  /** The places matching the query, as lib/app-index.ts's matchPlaces ranks them for this person. */
  places: readonly OmniPlace[];
  icons: ResultIcons;
}

/** The results for a query, by section, in the order they are listed. */
export function buildSections(input: SectionInput): Section[] {
  const { query, icons } = input;
  if (!query) return [];
  const needle = query.toLowerCase();
  const has = (text: string | null | undefined) => (text ?? '').toLowerCase().includes(needle);

  const pageResults = input.pages
    .filter((page) => has(page.label))
    .slice(0, LIMITS.pages)
    .map((page) => ({ href: page.href, label: page.label, icon: page.icon }));

  const projectResults = input.projects
    .filter((project) => has(project.name))
    .slice(0, LIMITS.projects)
    .map((project) => ({
      href: project.repoFullName ? `/code/${project.id}` : `/chat/projects/${project.id}`,
      label: project.name,
      detail: project.repoFullName ?? 'Chat project',
      icon: project.repoFullName ? icons.code : icons.pages,
    }));

  // A chat matches by its title or its project's name, or by a line said
  // in it. Title matches come first; a chat found only by what was said
  // shows that line under its title.
  const chatResult = (chat: ChatListItem, detail: string | undefined): Result => ({
    href: `/chat/${chat.id}`,
    label: chat.title ?? 'New chat',
    detail,
    icon: chat.projectKind === 'code' ? icons.code : chat.projectId ? icons.pages : icons.chat,
  });
  const titled = input.chats.filter(
    (chat) => has(chat.title ?? 'New chat') || has(chat.projectName)
  );
  const titledIds = new Set(titled.map((chat) => chat.id));
  const byTitle = titled.map((chat) => chatResult(chat, chat.projectName ?? undefined));
  const bySaid = input.chats
    .filter((chat) => input.hits.has(chat.id) && !titledIds.has(chat.id))
    .map((chat) => chatResult(chat, input.hits.get(chat.id)));

  // Settings, connectors and organization settings, each down to the
  // element that holds them.
  const placeResults = (section: OmniPlace['section']) =>
    input.places
      .filter((place) => place.section === section)
      .slice(0, LIMITS.places)
      .map((place): Result => ({
        // A connector not on the page is searched for in the catalog.
        href: section === 'Connectors' ? withFind(place.href, query) : place.href,
        label: place.title,
        detail: place.where,
        icon: place.icon,
      }));

  // The artifacts the library found for the words, each opened where it is.
  const artifactResults = input.artifacts.slice(0, LIMITS.artifacts).map((item): Result => ({
    href: `/chat/artifacts?artifact=${item.id}`,
    label: item.filename,
    detail: item.summary ?? item.chat?.title ?? 'Artifact',
    icon: icons.artifact,
  }));

  const sections: Section[] = [
    { title: 'Chats', results: [...byTitle, ...bySaid].slice(0, LIMITS.chats) },
    { title: 'Artifacts', results: artifactResults },
    { title: 'Projects', results: projectResults },
    { title: 'Pages', results: pageResults },
    { title: 'Organization', results: placeResults('Organization') },
    { title: 'Connectors', results: placeResults('Connectors') },
    { title: 'Settings', results: placeResults('Settings') },
  ];
  return sections.filter((section) => section.results.length > 0);
}
