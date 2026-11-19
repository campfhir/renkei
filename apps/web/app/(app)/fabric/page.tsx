import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getDataStore } from '@renkei/db';
import { FABRIC } from '@renkei/provider-grants';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import LocalTime from '@/components/local-time';
import FabricBrowser from './fabric-browser';

const STATUS_LABEL = { running: 'Preparing', succeeded: 'Ready', failed: 'Failed' } as const;

/**
 * Microsoft Fabric, as the signed-in person: their workspaces and what is
 * in them (fabric-browser.tsx), and the definitions they fetched lately —
 * each one a page of its own that streams in while Fabric prepares it.
 */
export default async function FabricPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl('/fabric'));

  const store = getDataStore();
  const [grant] = await store.providerGrants.listForSubject(session.subject, { provider: FABRIC });
  const recent = grant ? await store.fabricOperations.list(session.subject, { limit: 10 }) : [];

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-xl font-bold">Microsoft Fabric</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Your workspaces, lakehouses, notebooks and data pipelines, with the role you hold in each.
        Fabric can take a while to hand over a definition: it opens on a page of its own that fills
        in when Fabric is ready, and you are notified if you have moved on. Changes go through CI —
        ask in a chat to propose them to a code project, and its pipeline deploys them when merged
        (see Deployments).
      </p>
      {!grant ? (
        <div className="rounded-lg border border-gray-200 p-4 text-sm dark:border-gray-800">
          Microsoft Fabric is not connected.{' '}
          <Link href="/connectors" className="text-blue-600 hover:underline dark:text-blue-400">
            Connect it on the Connectors page
          </Link>{' '}
          — it is a connection of its own, separate from Microsoft 365.
        </div>
      ) : (
        <>
          <FabricBrowser />
          {recent.length > 0 && (
            <section className="mt-8" aria-labelledby="fabric-recent">
              <h2 id="fabric-recent" className="mb-2 text-sm font-semibold">
                Definitions you fetched
              </h2>
              <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
                {recent.map((operation) => (
                  <li
                    key={operation.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <Link
                      href={`/fabric/operations/${operation.id}`}
                      className="min-w-0 truncate text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {operation.itemName || operation.itemId}
                      <span className="text-gray-500"> · {operation.workspaceName}</span>
                    </Link>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-gray-500">
                      {STATUS_LABEL[operation.status]} ·{' '}
                      <LocalTime at={operation.createdAt.toISOString()} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
