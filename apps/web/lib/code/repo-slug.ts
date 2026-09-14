/**
 * A Bitbucket repository slug from the name someone types when creating a
 * new repository — lowercase ASCII, the character class the URL segment
 * (and connector-sandbox's REPO_FULL_NAME_PATTERN) accepts. Pure and
 * dependency-free so both the new-project form (client) and the create
 * route (server) can share it.
 */
const SLUG_MAX_CHARS = 62;

export function repoSlugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, SLUG_MAX_CHARS);
}
