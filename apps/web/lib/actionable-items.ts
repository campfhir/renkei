/**
 * Actionable-item execution: turning an approved suggestion into the real
 * Jira issue.
 *
 * Execution happens AS THE APPROVER (RENKEI.md Decision #2): the issue is
 * created with the approving user's own Jira grant, resolved through their
 * OIDC subject, so Jira's own permissions decide whether they may create it
 * and the issue history shows who actually did. There is no service-account
 * fallback here on purpose.
 */

import { getDatabase } from '@renkei/db';
import { getJiraGrant, ATLASSIAN } from '@/lib/tenant-operations';
import { jiraFetch, cacheTokenMetadata } from '@/lib/mcp-tools/common';
import { markdownToAdf } from '@/lib/mcp-tools/jira/markdown';
import { logger } from '@/lib/logger';

export interface CreateIssueArgs {
  summary: string;
  description: string;
  issueType: string;
}

export type ExecutionResult =
  { ok: true; issueKey: string; url: string } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow a stored suggested_action to create_issue args. The pipeline wrote
 * this shape, but it round-tripped through jsonb — verify, don't assume.
 */
export function readCreateIssueAction(suggestedAction: unknown): CreateIssueArgs | null {
  if (!isRecord(suggestedAction) || suggestedAction.tool !== 'create_issue') return null;
  const args = suggestedAction.args;
  if (!isRecord(args)) return null;
  const { summary, description, issueType } = args;
  if (typeof summary !== 'string' || typeof description !== 'string') return null;
  return {
    summary,
    description,
    issueType: typeof issueType === 'string' && issueType ? issueType : 'Task',
  };
}

export async function executeCreateIssue(
  tenantId: string,
  subject: string,
  args: CreateIssueArgs,
  projectKey: string
): Promise<ExecutionResult> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return { ok: false, error: 'database unavailable' };

  // The approver's own grant, by subject — never someone else's.
  const grantRow = await dbResult.val
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', ATLASSIAN)
    .where('subject', '=', subject)
    .executeTakeFirst();
  if (!grantRow) {
    return { ok: false, error: 'You have no Jira connection; connect Jira before approving.' };
  }

  const grantResult = await getJiraGrant(tenantId, grantRow.provider_account_id);
  if (!grantResult.ok || !grantResult.val) {
    return { ok: false, error: 'Your Jira grant could not be loaded; try reconnecting Jira.' };
  }
  const grant = grantResult.val;

  cacheTokenMetadata(grant.accessToken, tenantId, grant.accountId);
  const apiBaseUrl = `https://api.atlassian.com/ex/jira/${grant.cloudId}`;

  try {
    const response = await jiraFetch(`${apiBaseUrl}/rest/api/3/issue`, grant.accessToken, {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          summary: args.summary,
          issuetype: { name: args.issueType },
          description: markdownToAdf(args.description),
        },
      }),
    });
    const created: unknown = await response.json();
    const issueKey = isRecord(created) && typeof created.key === 'string' ? created.key : null;
    if (!issueKey) return { ok: false, error: 'Jira did not return an issue key' };

    logger.info('Issue created from approved card', {
      component: 'cards/execute',
      tenantId,
      subject,
      issueKey,
    });
    return { ok: true, issueKey, url: `${grant.siteUrl}/browse/${issueKey}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Issue creation failed', {
      component: 'cards/execute',
      tenantId,
      subject,
      error: message,
    });
    return { ok: false, error: message };
  }
}
