/**
 * A GitHub workflow file's name, as the Actions page and its route both
 * accept it: a plain file name under `.github/workflows/`, yaml or yml.
 * Pure, so the page's model can say whether Commit is allowed with the
 * same rule the server enforces.
 */

export const WORKFLOWS_DIRECTORY = '.github/workflows';

/** `ci.yml`-shaped, or null. */
export function workflowFileName(raw: string): string | null {
  const name = raw.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.ya?ml$/i.test(name) && !name.includes('..')
    ? name
    : null;
}
