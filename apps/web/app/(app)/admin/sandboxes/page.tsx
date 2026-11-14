import React from 'react';
import { redirect } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { readSandboxes } from '@/lib/sandboxes-admin';
import SandboxesForm from './sandboxes-form';

/**
 * Where the organization's sandboxes are made, and what each is started
 * with: the setup the sandbox orchestrator works from
 * (docs/sandbox-orchestrator-design.md). Stored sealed, like a
 * connector's credentials; the orchestrator picks a change up by itself.
 */
export default async function SandboxesPage(): Promise<React.ReactNode> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    redirect(`/admin`);
  }
  const view = await readSandboxes();
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Sandboxes</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Each person, agent and project works in a sandbox of its own, made the first time it is
        needed, suspended when idle and evicted after a day unused. This is where they are made and
        what each is started with. Secrets are sealed with the deployment key and never shown again
        after saving. The sandboxes themselves are made for you; nothing here is created by hand.
      </p>
      <SandboxesForm initial={view === 'ERROR' ? null : view} />
    </div>
  );
}
