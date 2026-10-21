import React from 'react';
import { redirect } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import ServerManager from './server-manager';

/**
 * Remote MCP servers — the list. Each row is one server an admin chose to
 * offer: where it is, how it speaks, and what it is for. Signing in is the
 * server's business — everyone connects it from the Connectors page and the
 * server decides what that account may do — and the tools a person sees are
 * whatever the server lists for them.
 */
export default async function AdminMcpPage(): Promise<React.ReactNode> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    redirect(`/admin`);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">MCP servers</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Remote MCP servers your organization offers. List where each one is; people sign in at the
        server from the Connectors page, and the server decides what their account may do. Its tools
        are listed live and found in chat by the server&apos;s name — the context you write here
        helps the model and people pick the right server.
      </p>
      <ServerManager />
    </div>
  );
}
