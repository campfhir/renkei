import type { ReactNode } from 'react';
import Link from 'next/link';
import BackLink from '@/components/back-link';
import AppTabs from './app-tabs';
import { appProject } from './app-project';

/**
 * One app under Deployments — a code project — with its three tabs: what it
 * deployed where and promoting it (the page), its pipeline built from
 * blocks (pipeline/), and its host's runs and variables (runs/).
 */
export default async function DeploymentAppLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const app = await appProject(projectId, `/deployments/${projectId}`);
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <BackLink href="/deployments" label="Deployments" />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-mono text-xl font-bold break-all">{app.name}</h1>
        <span className="text-sm text-gray-500">
          {app.host === 'github' ? 'GitHub' : 'Bitbucket'} ·{' '}
          <span className="font-mono break-all">{app.repo}</span>
        </span>
        <Link
          href={`/code/${app.id}`}
          className="text-sm text-blue-600 hover:underline dark:text-blue-400"
        >
          Open the code project
        </Link>
      </div>
      <AppTabs projectId={app.id} />
      {children}
    </div>
  );
}
