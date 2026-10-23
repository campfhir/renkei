/**
 * What the Artifacts page asks the library for, as the URL carries it
 * (`/chat/artifacts?q=…&show=…&project=…&page=…`): the parsing the page
 * and the route share, and the query string the client builds. Pure, so
 * the browser bundle can hold it; the query itself is
 * artifact-library-query.ts.
 */

export type LibraryShow = 'all' | 'uploaded' | 'generated' | 'shared';

export interface LibraryFilters {
  show: LibraryShow;
  /** Only files this project holds. */
  projectId: string | null;
  /** Words to find in a file's name, summary or keywords. */
  query: string;
}

export interface LibraryQuery extends LibraryFilters {
  /** 1-based. */
  page: number;
  /** A file to open to: the page is the one it sits on when `page` was not asked for. */
  focus: string | null;
}

/** Rows per page: enough to scan, few enough that the pager means something. */
export const LIBRARY_PAGE_SIZE = 25;
export const QUERY_MAX_CHARS = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isLibraryShow(value: unknown): value is LibraryShow {
  return value === 'all' || value === 'uploaded' || value === 'generated' || value === 'shared';
}

/** The query's words, lowercased, as the name match wants them. */
export function queryTermsOf(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function read(params: Params, key: string): string | null {
  if (params instanceof URLSearchParams) return params.get(key);
  const value = params[key];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

/** The URL's parameters as a query; anything malformed falls back to the default. */
export function parseLibraryQuery(params: Params): LibraryQuery {
  const show = read(params, 'show');
  const project = read(params, 'project') ?? '';
  const page = Number(read(params, 'page') ?? '1');
  const focus = read(params, 'artifact') ?? '';
  return {
    show: isLibraryShow(show) ? show : 'all',
    projectId: UUID_RE.test(project) ? project : null,
    query: (read(params, 'q') ?? '').trim().slice(0, QUERY_MAX_CHARS),
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    focus: UUID_RE.test(focus) ? focus : null,
  };
}

/** The query string for a page of the library; defaults are left out so the plain page stays `/chat/artifacts`. */
export function libraryQueryString(
  filters: LibraryFilters,
  page: number,
  focus: string | null = null
): string {
  const params = new URLSearchParams();
  if (filters.query.trim()) params.set('q', filters.query.trim());
  if (filters.show !== 'all') params.set('show', filters.show);
  if (filters.projectId) params.set('project', filters.projectId);
  if (page > 1) params.set('page', String(page));
  if (focus) params.set('artifact', focus);
  const string = params.toString();
  return string ? `?${string}` : '';
}
