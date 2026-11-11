/**
 * Where GitHub's own Actions pages are, for a repository `owner/name` —
 * pure, so the Actions page can link to them: the repository's Actions
 * tab, and the page where a person adds a secret (which this app lists by
 * name but cannot set; see github-actions.ts).
 */

function repoRoot(fullName: string): string | null {
  const [owner, repo, ...rest] = fullName.split('/');
  if (!owner || !repo || rest.length > 0) return null;
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** The repository's Actions tab on github.com. */
export function actionsUrl(fullName: string): string | null {
  const root = repoRoot(fullName);
  return root ? `${root}/actions` : null;
}

/** Where a person adds an Actions secret. */
export function actionsSecretsUrl(fullName: string): string | null {
  const root = repoRoot(fullName);
  return root ? `${root}/settings/secrets/actions` : null;
}
