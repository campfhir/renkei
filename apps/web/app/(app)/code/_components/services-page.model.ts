/**
 * The Services page's state (services-page.tsx): the services and allowed
 * images as the worker last answered, the start form, what the last
 * change did, and the combined log tail.
 *
 * The component makes the calls, runs the tail's poll and scrolls it;
 * everything the page decides — what the start form opens with and when
 * Start can be pressed, what it sends, what Stop asks first, what a
 * running service's line says it sets, the heading's count, which lines
 * the tail keeps and shows and what it says when there are none — is
 * here, and tested in services-page.model.test.ts.
 */

import type { WireService, WireServiceLogEntry } from '@renkei/sandbox-client';
import type { ServicesView } from '@/lib/code/services';

export interface StartDraft {
  name: string;
  image: string;
  env: string;
  exports: string;
}

/** What the start form opens with: a Postgres a test suite can use as it is. */
export const EMPTY_START: StartDraft = {
  name: 'db',
  image: 'postgres:16',
  env: 'POSTGRES_PASSWORD=test\nPOSTGRES_DB=app',
  exports: 'DATABASE_URL=postgres://postgres:test@{host}:{port}/app',
};

export interface ServicesState {
  /** null until the first read answers. */
  view: ServicesView | null;
  loadError: string | null;
  /** The last change the worker refused. */
  error: string | null;
  busy: boolean;
  draft: StartDraft | null;
  /** The service just started from here, named until the next change. */
  started: string | null;
}

export const initialServices: ServicesState = {
  view: null,
  loadError: null,
  error: null,
  busy: false,
  draft: null,
  started: null,
};

export type ServicesAction =
  | { type: 'loaded'; view: ServicesView }
  | { type: 'loadFailed'; error: string }
  | { type: 'startOpened' }
  | { type: 'draftChanged'; field: keyof StartDraft; value: string }
  | { type: 'draftCancelled' }
  /** A start or a stop went out. */
  | { type: 'sent' }
  /** It was refused; the form stays as it was. */
  | { type: 'failed'; error: string }
  /** A start was taken (and the list read again); `name` is what the worker called it. */
  | { type: 'startDone'; name: string | null }
  | { type: 'stopDone' };

export function servicesReducer(state: ServicesState, action: ServicesAction): ServicesState {
  switch (action.type) {
    case 'loaded':
      return { ...state, view: action.view, loadError: null };
    case 'loadFailed':
      return { ...state, loadError: action.error };
    case 'startOpened':
      return { ...state, draft: EMPTY_START };
    case 'draftChanged':
      return state.draft
        ? { ...state, draft: { ...state.draft, [action.field]: action.value } }
        : state;
    case 'draftCancelled':
      return { ...state, draft: null };
    case 'sent':
      return { ...state, busy: true, error: null, started: null };
    case 'failed':
      return { ...state, busy: false, error: action.error };
    case 'startDone':
      return {
        ...state,
        busy: false,
        started: action.name ?? state.draft?.name.trim() ?? null,
        draft: null,
      };
    case 'stopDone':
      return { ...state, busy: false };
  }
}

/** Start can be pressed: a name and an image, and nothing in flight. */
export function canStart(state: ServicesState): boolean {
  return (
    !state.busy && state.draft !== null && !!state.draft.name.trim() && !!state.draft.image.trim()
  );
}

/** What Start sends: the name and image trimmed, the variables and exports as typed. */
export function startRequest(draft: StartDraft): StartDraft {
  return {
    name: draft.name.trim(),
    image: draft.image.trim(),
    env: draft.env,
    exports: draft.exports,
  };
}

/** What Stop asks first: the container goes with its data. */
export function stopQuestion(service: Pick<WireService, 'name'>): string {
  return `Stop ${service.name}? The container is removed with its data; the name is free again.`;
}

/** How many are running, as the heading's pill says it. */
export function runningPill(services: Pick<WireService, 'status'>[]): {
  tone: 'green' | 'gray';
  label: string;
} {
  const running = services.filter((service) => service.status === 'running').length;
  return running
    ? { tone: 'green', label: `${running} running` }
    : { tone: 'gray', label: 'None running' };
}

/** `db` → `SERVICE_DB`, as the worker names a service's variables. */
export function envPrefix(name: string): string {
  return `SERVICE_${name.toUpperCase().replace(/-/g, '_')}`;
}

/** Every variable a running service sets for each command: its host, its port when it has one, its exports. */
export function variablesSet(
  service: Pick<WireService, 'name' | 'ports' | 'exportNames'>
): string[] {
  const prefix = envPrefix(service.name);
  return [
    `${prefix}_HOST`,
    ...(service.ports.length ? [`${prefix}_PORT`] : []),
    ...service.exportNames,
  ];
}

/** Whether a service's line gives its address, or its error (else "Not running."). */
export function serviceReachable(service: Pick<WireService, 'status' | 'host'>): boolean {
  return service.status === 'running' && !!service.host;
}

/** A service's status as its pill reads. */
export function serviceStatusPill(status: WireService['status']): {
  tone: 'green' | 'blue' | 'red' | 'gray';
  label: string;
} {
  const tone =
    status === 'running'
      ? 'green'
      : status === 'starting'
        ? 'blue'
        : status === 'failed'
          ? 'red'
          : 'gray';
  return { tone, label: status.charAt(0).toUpperCase() + status.slice(1) };
}

/** An allowed pattern as the image field suggests it: a namespace's `/*` left open to type into. */
export function imageSuggestion(pattern: string): string {
  return pattern.endsWith('/*') ? pattern.slice(0, -1) : pattern;
}

// ── The combined log tail ──

/** Lines kept on the page; the oldest go as new ones arrive. */
export const TAIL_KEEP = 2_000;

export interface TailState {
  entries: WireServiceLogEntry[];
  follow: boolean;
  /** One service's name, or empty for all. */
  filter: string;
  truncated: boolean;
  unreadable: string[];
  error: string | null;
  loaded: boolean;
}

export const initialTail: TailState = {
  entries: [],
  follow: true,
  filter: '',
  truncated: false,
  unreadable: [],
  error: null,
  loaded: false,
};

export type TailAction =
  /** A read answered: the recent past (`since` false) replaces, what came after (`since` true) appends. */
  | {
      type: 'read';
      since: boolean;
      entries: WireServiceLogEntry[];
      truncated: boolean;
      unreadable: string[];
    }
  | { type: 'readFailed'; error: string }
  | { type: 'cleared' }
  | { type: 'followChanged'; follow: boolean }
  | { type: 'filterChanged'; filter: string };

export function tailReducer(state: TailState, action: TailAction): TailState {
  switch (action.type) {
    case 'read': {
      const next = action.since ? [...state.entries, ...action.entries] : action.entries;
      return {
        ...state,
        error: null,
        entries: next.length > TAIL_KEEP ? next.slice(next.length - TAIL_KEEP) : next,
        truncated: action.since ? state.truncated : action.truncated,
        unreadable: action.unreadable,
        loaded: true,
      };
    }
    case 'readFailed':
      return { ...state, error: action.error };
    case 'cleared':
      return { ...state, entries: [] };
    case 'followChanged':
      return { ...state, follow: action.follow };
    case 'filterChanged':
      return { ...state, filter: action.filter };
  }
}

/** The tail's query: the recent past, or what came after the cursor. */
export function tailQuery(since: string | null): string {
  return since ? `?since=${encodeURIComponent(since)}` : '?lines=200';
}

/** The cursor after a read: its last line's stamp, or the one before when it brought nothing. */
export function nextCursor(previous: string | null, fresh: WireServiceLogEntry[]): string | null {
  return fresh.length ? fresh[fresh.length - 1]!.at : previous;
}

/** The lines on screen: every one, or one service's. */
export function shownEntries(state: TailState): WireServiceLogEntry[] {
  return state.filter
    ? state.entries.filter((entry) => entry.service === state.filter)
    : state.entries;
}

/** What the pane says with no lines to show. */
export function emptyTailText(state: TailState, services: string[]): string {
  if (!state.loaded) return 'Reading…';
  if (services.length === 0) return '(no services)';
  return state.filter ? `(nothing from ${state.filter} yet)` : '(nothing yet)';
}

/** A line's service name is shown only in the mixed stream: filtered to one, it would repeat. */
export function showsServiceName(state: TailState): boolean {
  return !state.filter;
}

/** The time of day a line was written, to the millisecond, from its RFC 3339 stamp. */
export function clockOf(at: string): string {
  const time = at.slice(11, 23);
  return time.endsWith('.') ? time.slice(0, -1) : time;
}

/** Which of the tones a service's name gets: by its place in the list, round again past the last. */
export function toneIndex(services: string[], service: string, tones: number): number {
  return Math.max(0, services.indexOf(service)) % tones;
}

/** Whether the tail asks again every few seconds: following, with something to follow. */
export function polls(state: TailState, services: string[]): boolean {
  return state.follow && services.length > 0;
}
