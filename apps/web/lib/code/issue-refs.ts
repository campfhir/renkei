/**
 * Issue references guessed out of a PR's title (or, failing that, the
 * project's branch name) — a Jira key or a GitHub issue number. This is
 * a best-effort signal, not a structural guarantee: neither a branch
 * name nor a PR title has an enforced format (see
 * lib/mcp-tools/jira/transcript.ts's ISSUE_KEY, whose pattern this one
 * mirrors — kept as its own small copy here rather than an import,
 * since that module's export surface is meeting-transcript-shaped, not
 * a general issue-key utility). A wrong guess is expected to just fail
 * to resolve to a real issue, not to be filtered out here.
 */

export const JIRA_ISSUE_KEY_RE = /\b[A-Z][A-Z0-9_]*-\d+\b/g;
export const GITHUB_ISSUE_REF_RE = /#(\d+)\b/g;

export interface DetectedIssueRefs {
  jiraKey: string | null;
  githubIssueNumber: number | null;
}

/**
 * Scans the PR's title first — prose written for a person to read is a
 * more reliable source than a branch name a model chose freehand — and
 * falls back to the branch only when the title names nothing. A GitHub
 * match equal to the PR's own number is excluded (its own "#42" in its
 * own title names itself, not an issue).
 */
export function detectIssueRefs(input: {
  branch?: string | null;
  prTitle?: string | null;
  prNumber?: number | null;
}): DetectedIssueRefs {
  const title = (input.prTitle ?? '').trim();
  const source = title || (input.branch ?? '');

  const jiraKey = source.match(JIRA_ISSUE_KEY_RE)?.[0] ?? null;

  let githubIssueNumber: number | null = null;
  for (const match of source.matchAll(GITHUB_ISSUE_REF_RE)) {
    const number = Number(match[1]);
    if (Number.isFinite(number) && number !== input.prNumber) {
      githubIssueNumber = number;
      break;
    }
  }

  return { jiraKey, githubIssueNumber };
}
