/**
 * Presentation helpers shared between the email-sanitizer admin page and the
 * mail-review page. A "sender key" is an admin-defined free-text identifier
 * ("jira", "epic_hosting") used internally to pick an extraction template —
 * never something to show a non-technical user verbatim.
 */

/** "jira" → "Jira", "epic_hosting" → "Epic Hosting". Display-only — never stored. */
export function humanizeSystemName(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return key;
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
