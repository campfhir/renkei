/**
 * Issue cards for a chat's most recent pull request — a Jira issue and
 * a GitHub issue, guessed from the PR's title (or the project's branch,
 * lib/code/issue-refs.ts's detectIssueRefs) and fetched live, with the
 * signed-in person's own grant on each connector. Either — or both —
 * comes back null on no usable token, an API failure, or simply no
 * match: never an error the UI has to render, per the "hide the
 * component" requirement this feature started from.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { ATLASSIAN } from '@renkei/provider-grants';
import { jsonError } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { resolveChatAccess } from '@/lib/chat/access';
import { listMessages, toMessageView } from '@/lib/chat/messages';
import { latestPrInTranscript } from '@/lib/code/chat-commits';
import { detectIssueRefs } from '@/lib/code/issue-refs';
import { getOrigin } from '@/lib/get-origin';
import { resolveAtlassianUserAccess } from '@/lib/atlassian-user-access';
import { jiraFetch } from '@/lib/mcp-tools/common';
import { githubAuthOf } from '@/lib/code/github-browse';
import { ghJson, rec, str } from '@/lib/mcp-tools/github/client';

interface JiraCard {
  key: string;
  title: string;
  status: string;
  url: string;
}

interface GitHubIssueCard {
  number: number;
  title: string;
  state: string;
  url: string;
}

async function lookupJira(
  tenantId: string,
  subject: string,
  origin: string,
  key: string
): Promise<JiraCard | null> {
  const access = await resolveAtlassianUserAccess(tenantId, subject, ATLASSIAN, origin);
  if (typeof access === 'string') return null;
  try {
    const response = await jiraFetch(
      `https://api.atlassian.com/ex/jira/${access.cloudId}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status`,
      access.accessToken
    );
    if (!response.ok) return null;
    const body: unknown = await response.json().catch(() => null);
    const fields = rec(rec(body).fields);
    return {
      key,
      title: str(fields.summary),
      status: str(rec(fields.status).name),
      url: `https://${access.cloudId}.atlassian.net/browse/${key}`,
    };
  } catch {
    return null;
  }
}

async function lookupGitHubIssue(
  tenantId: string,
  subject: string,
  origin: string,
  fullName: string,
  number: number
): Promise<GitHubIssueCard | null> {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return null;
  const auth = githubAuthOf({ tenantId, subject, origin });
  const result = await ghJson(
    auth,
    ['repository'],
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`
  );
  if (!result.ok) return null;
  const issue = rec(result.body);
  if (!str(issue.title)) return null;
  return {
    number,
    title: str(issue.title),
    state: str(issue.state),
    url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string; chatId: string }> }
): Promise<Response> {
  const { tenantId, projectId, chatId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId);
  if (!ready.ok) return ready.response;
  const { db, session, project } = ready.context;
  const chatAccess = await resolveChatAccess(db, tenantId, session.subject, chatId);
  if (!chatAccess) return jsonError(404, 'not-found', 'No such chat');

  const rows = await listMessages(db, tenantId, chatId);
  const pullRequest = latestPrInTranscript(rows.map(toMessageView));
  const refs = detectIssueRefs({
    branch: project.repo!.branch,
    prTitle: pullRequest?.title ?? null,
    prNumber: pullRequest?.number ?? null,
  });

  const origin = await getOrigin(request);
  const originVal = origin.ok ? origin.val : '';
  const [jira, github] = await Promise.all([
    refs.jiraKey ? lookupJira(tenantId, session.subject, originVal, refs.jiraKey) : null,
    refs.githubIssueNumber && project.repo!.provider === 'github'
      ? lookupGitHubIssue(
          tenantId,
          session.subject,
          originVal,
          project.repo!.fullName,
          refs.githubIssueNumber
        )
      : null,
  ]);

  return NextResponse.json({ jira, github });
}
