/**
 * The composer's `@` query as the glob the sandbox worker's `find`
 * takes (rg --glob): the typed text anywhere in a path, with glob
 * syntax stripped from it — a bracket or a star in what somebody typed
 * is a character they want, not a pattern — and no leading slash or
 * backslash, which the worker refuses (validateGlob).
 */

const QUERY_MAX_CHARS = 200;

export function findGlob(query: string): string {
  const literal = query
    .replace(/[*?[\]{}!\\]/g, '')
    .replace(/^\/+/, '')
    .slice(0, QUERY_MAX_CHARS);
  return literal ? `**/*${literal}*` : '**/*';
}
