'use client';

/**
 * Small cards for the Jira issue and/or GitHub issue guessed from the
 * active chat's most recent pull request (…/chats/[chatId]/issues,
 * lib/code/issue-refs.ts's detectIssueRefs) — a Jira key or a GitHub
 * issue number read out of the PR's title, then fetched live with the
 * signed-in person's own grant on each connector. Renders nothing at
 * all when neither resolves: no token, an API failure, or simply no
 * reference found are all the same "say nothing" case here, not an
 * error state to show.
 */

import { useEffect, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { getJson } from '@/lib/fetch-json';
import Pill from './pill';

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

interface IssuesResponse {
  jira: JiraCard | null;
  github: GitHubIssueCard | null;
}

function Card({ icon, label, title, sub, url }: {
  icon: string;
  label: string;
  title: string;
  sub: string;
  url: string;
}) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-w-0 items-center gap-2 rounded-md border border-gray-200 px-2.5 py-1.5 text-sm hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
    >
      <Icon path={icon} className="h-4 w-4 shrink-0 text-gray-400" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">
          {label} {title ? `· ${title}` : ''}
        </span>
      </span>
      {sub ? <Pill tone="gray">{sub}</Pill> : null}
    </a>
  );
}

export default function IssueCards({
  tenantId,
  projectId,
  chatId,
}: {
  tenantId: string;
  projectId: string;
  chatId: string;
}) {
  const [issues, setIssues] = useState<IssuesResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getJson<IssuesResponse>(
        `/api/tenant/${tenantId}/code/projects/${projectId}/chats/${chatId}/issues`
      );
      if (!cancelled && result.data) setIssues(result.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, projectId, chatId]);

  if (!issues || (!issues.jira && !issues.github)) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {issues.jira ? (
        <Card
          icon={ICONS.approval}
          label={issues.jira.key}
          title={issues.jira.title}
          sub={issues.jira.status}
          url={issues.jira.url}
        />
      ) : null}
      {issues.github ? (
        <Card
          icon={ICONS.approval}
          label={`#${issues.github.number}`}
          title={issues.github.title}
          sub={issues.github.state}
          url={issues.github.url}
        />
      ) : null}
    </div>
  );
}
