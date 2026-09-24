/**
 * Pure group-membership helpers — no I/O, so they are unit-tested without
 * a server. See docs/admanager-connector-design.md's "Group membership:
 * additive verbs, not a replace-the-list PATCH" for why group changes
 * never go through the ambiguous `memberOf` attribute: everything here
 * feeds the explicit addUsersToGroups/removeUsersFromGroups endpoints,
 * which are additive/subtractive by construction.
 */

/**
 * ADManager Plus reports a user's MEMBER_OF as an array of group
 * distinguished names (`CN=Finance-ReadOnly,OU=Groups,DC=corp,DC=example`).
 * The tools work in group NAMES (the CN), which is what
 * addUsersToGroups/removeUsersFromGroups take. A DN that doesn't parse as
 * expected is dropped rather than guessed at.
 */
export function groupNamesFromDns(dns: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const dn of dns) {
    if (typeof dn !== 'string') continue;
    const match = /^CN=((?:[^,\\]|\\.)*)/i.exec(dn.trim());
    if (!match) continue;
    const name = match[1].replace(/\\(.)/g, '$1').trim();
    if (name) names.push(name);
  }
  return names;
}

/** Case-insensitive de-duplication, preserving the first-seen casing. */
export function dedupeGroupNames(names: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }
  return [...seen.values()];
}

/**
 * The groups a "copy membership" merge would actually add: every group
 * the source has that the target does not, case-insensitively. Never
 * removes a group the target already holds that the source doesn't —
 * copying grants what's missing, it does not narrow the target's access.
 */
export function groupsToAdd(
  sourceGroups: readonly string[],
  targetGroups: readonly string[]
): string[] {
  const targetKeys = new Set(targetGroups.map((name) => name.trim().toLowerCase()));
  return dedupeGroupNames(sourceGroups).filter(
    (name) => !targetKeys.has(name.trim().toLowerCase())
  );
}

/** Group names actually present in `currentGroups` (case-insensitively) — for a remove preview. */
export function groupsPresent(
  requestedGroups: readonly string[],
  currentGroups: readonly string[]
): string[] {
  const currentKeys = new Set(currentGroups.map((name) => name.trim().toLowerCase()));
  return dedupeGroupNames(requestedGroups).filter((name) =>
    currentKeys.has(name.trim().toLowerCase())
  );
}
