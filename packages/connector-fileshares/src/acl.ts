/**
 * The ACL evaluator — pure functions over an AclContext, no I/O, so every
 * rule of the model is pinned by a unit test rather than by a file server.
 *
 * The model, in evaluation order:
 *
 *   1. A disabled share, or one with no stored credential, answers 'none'
 *      for every path. There is no anonymous fallback.
 *   2. Each layer (share-wide, per-user) answers with the access of the
 *      LONGEST of its rules whose path is a directory-boundary prefix of
 *      the asked path — inheritance down, deeper rules override shallower
 *      ones, allow and deny alike. No rule matches ⇒ the layer's implicit
 *      '/' default (the share's max_access, the grant's default_access).
 *   3. The effective level is the minimum of the ceiling and both layers:
 *      layers narrow, never widen.
 *
 * One deliberate wrinkle: a directory whose own level is 'none' can still
 * appear in listings as 'traverse' when a deeper rule under it grants
 * access — otherwise "longest path wins" would let a carve-in be read by
 * exact path while browsing could never find it. Traversal reveals only the
 * directory's name and the chain down to the allowed subtree; everything
 * else inside stays hidden.
 */

import { childPath, isBoundaryPrefix } from './paths';
import { minAccess } from './types';
import type { AccessLevel, AclContext, PathRule, RawEntry, ShareEntry } from './types';

/**
 * One layer's answer for a path: longest matching rule wins; among equal
 * longest matches (possible only under case folding, e.g. rules at '/A' and
 * '/a') the most restrictive wins — ambiguity fails closed.
 */
export function layerAccess(
  rules: readonly PathRule[],
  path: string,
  layerDefault: AccessLevel,
  caseInsensitive: boolean
): AccessLevel {
  let bestLength = -1;
  let best: AccessLevel = layerDefault;
  for (const rule of rules) {
    if (!isBoundaryPrefix(rule.path, path, caseInsensitive)) continue;
    if (rule.path.length > bestLength) {
      bestLength = rule.path.length;
      best = rule.access;
    } else if (rule.path.length === bestLength) {
      best = minAccess(best, rule.access);
    }
  }
  return best;
}

/** The caller's effective access at one path. */
export function effectiveAccess(ctx: AclContext, path: string): AccessLevel {
  if (!ctx.share.enabled || !ctx.share.hasCredentials) return 'none';
  const ci = ctx.share.caseInsensitive;
  const shareLayer = layerAccess(ctx.shareRules, path, ctx.share.maxAccess, ci);
  const userLayer = layerAccess(ctx.userRules, path, ctx.grant.defaultAccess, ci);
  return minAccess(ctx.share.maxAccess, minAccess(shareLayer, userLayer));
}

/**
 * Whether some rule strictly under `path` grants access the caller can
 * actually exercise — the test that turns a closed directory into a
 * 'traverse' entry instead of an invisible one. Rule paths are the only
 * candidates worth checking: between rule boundaries access never changes.
 */
export function hasAllowedDescendant(ctx: AclContext, path: string): boolean {
  if (!ctx.share.enabled || !ctx.share.hasCredentials) return false;
  const ci = ctx.share.caseInsensitive;
  for (const rule of [...ctx.shareRules, ...ctx.userRules]) {
    if (rule.access === 'none') continue;
    if (!isBoundaryPrefix(path, rule.path, ci)) continue;
    // Strictly deeper only — the path's own level was already judged.
    const samePath = ci ? rule.path.toLowerCase() === path.toLowerCase() : rule.path === path;
    if (samePath) continue;
    if (effectiveAccess(ctx, rule.path) !== 'none') return true;
  }
  return false;
}

/**
 * Whether a folder may be LISTED at all: readable in its own right, or
 * traverse-only on the way to a deeper allow.
 */
export function canListFolder(ctx: AclContext, path: string): boolean {
  return effectiveAccess(ctx, path) !== 'none' || hasAllowedDescendant(ctx, path);
}

/**
 * The ACL pass over a directory listing: closed entries vanish, closed
 * directories shielding a deeper allow become 'traverse', everything else
 * carries the level the caller holds on it.
 */
export function annotateEntries(
  ctx: AclContext,
  dirPath: string,
  entries: readonly RawEntry[]
): ShareEntry[] {
  const out: ShareEntry[] = [];
  for (const entry of entries) {
    const path = childPath(dirPath, entry.name);
    const access = effectiveAccess(ctx, path);
    if (access === 'none') {
      if (entry.kind === 'dir' && hasAllowedDescendant(ctx, path)) {
        out.push({ ...entry, path, access: 'traverse' });
      }
      continue;
    }
    out.push({ ...entry, path, access });
  }
  return out;
}
