/**
 * Path normalization is the connector's first security boundary, so its
 * rules are strict and deliberately unforgiving:
 *
 *   - Backslashes are separators, always. SMB servers treat them as such,
 *     so a segment like `a\..\b` that survived as one "name" here would be
 *     re-split on the wire into the traversal it was hiding. Folding them
 *     to `/` before splitting closes that gap for SFTP too, at the cost of
 *     not supporting filenames that genuinely contain backslashes — a cost
 *     accepted on purpose.
 *   - `..` is rejected, never resolved. Resolving would turn a review
 *     question ("why does this path climb?") into silent behavior.
 *   - The output is always absolute, `/`-rooted, trailing-slash-free —
 *     one canonical spelling per path, which is what makes longest-prefix
 *     rule matching sound.
 *
 * Everything here is pure and dependency-free so the same functions run in
 * the admin UI (live UNC translation preview) and on every server boundary.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export type PathError = 'PATH_TRAVERSAL' | 'INVALID_PATH';

/**
 * Canonicalize a user-supplied path to the normalized Unix form all rules
 * and backends speak. Empty input and '/' both mean the root.
 */
export function normalizePath(input: string): Result<string, PathError> {
  if (input.includes('\0')) return err('INVALID_PATH' as const);

  const segments = input.replace(/\\/g, '/').split('/');
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    // Rejected rather than resolved: a climbing path is either an attack or
    // a bug, and both deserve an error the caller can see.
    if (segment === '..') return err('PATH_TRAVERSAL' as const);
    kept.push(segment);
  }
  return ok('/' + kept.join('/'));
}

/**
 * Translate the Windows spellings people paste — `\\server\share\folder`,
 * `C:\folder`, `share\folder` — into slash form. Translation only: the UNC
 * server and share components are dropped (the share row already names
 * them), and the caller still normalizes the result.
 */
export function windowsToUnix(input: string): string {
  const slashed = input.replace(/\\/g, '/');
  // UNC: //server/share/rest → /rest
  const unc = /^\/\/+[^/]+\/+[^/]+(\/.*)?$/.exec(slashed);
  if (unc) return unc[1] ?? '/';
  // Drive letter: C:/rest → /rest
  const drive = /^[A-Za-z]:(\/.*)?$/.exec(slashed);
  if (drive) return drive[1] ?? '/';
  return slashed;
}

/**
 * Whether `prefix` covers `path` at a directory boundary: '/foo' covers
 * '/foo' and '/foo/bar', never '/foobar'. Both arguments must already be
 * normalized; case folding is the share's choice, not the caller's.
 */
export function isBoundaryPrefix(prefix: string, path: string, caseInsensitive: boolean): boolean {
  const a = caseInsensitive ? prefix.toLowerCase() : prefix;
  const b = caseInsensitive ? path.toLowerCase() : path;
  if (a === '/') return true;
  return b === a || b.startsWith(a + '/');
}

/**
 * Build the on-wire path for a backend: the share's root plus a normalized
 * share-relative path. Structurally the result cannot escape the root — the
 * relative part carries no `..` — but the containment is re-verified anyway,
 * because this is the last code the path passes before a socket.
 */
export function joinUnder(root: string, relative: string): Result<string, PathError> {
  const normalizedRoot = normalizePath(root);
  if (!normalizedRoot.ok) return normalizedRoot;
  const normalizedRelative = normalizePath(relative);
  if (!normalizedRelative.ok) return normalizedRelative;

  const joined =
    normalizedRoot.val === '/'
      ? normalizedRelative.val
      : normalizedRelative.val === '/'
        ? normalizedRoot.val
        : normalizedRoot.val + normalizedRelative.val;

  if (!isBoundaryPrefix(normalizedRoot.val, joined, false)) {
    return err('PATH_TRAVERSAL' as const);
  }
  return ok(joined);
}

/** The parent of a normalized path; '/' is its own parent. */
export function parentPath(path: string): string {
  if (path === '/') return '/';
  const cut = path.lastIndexOf('/');
  return cut === 0 ? '/' : path.slice(0, cut);
}

/** Append one entry name to a normalized directory path. */
export function childPath(dir: string, name: string): string {
  return dir === '/' ? '/' + name : dir + '/' + name;
}
