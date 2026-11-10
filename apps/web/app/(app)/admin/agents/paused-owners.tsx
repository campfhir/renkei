import React from 'react';
import Link from 'next/link';
import { agoText, stateText, type PausedOwner } from '@/lib/agents/paused-owners';

/**
 * Agent oversight's "Paused people": everyone with an enabled agent whose
 * agents cannot run unattended right now, and why — so an operator learns
 * in a minute what used to show only as weeks of parked runs. Rules and
 * order in lib/agents/paused-owners.ts.
 */
export default function PausedOwners({
  owners,
  now,
}: {
  owners: PausedOwner[];
  now: number;
}): React.ReactNode {
  return (
    <section aria-labelledby="paused-people" className="mb-6">
      <h2 id="paused-people" className="mb-1 text-base font-semibold">
        Paused people
      </h2>
      {owners.length === 0 ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Everyone with an enabled agent can run it right now.
        </p>
      ) : (
        <>
          <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
            These people have agents switched on that cannot run while they are away. A person fixes
            it by opening the app on a device that holds their key; nothing an operator can press
            does it for them.
          </p>
          <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
            {owners.map((owner) => (
              <li
                key={owner.subject}
                className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-start sm:justify-between sm:gap-4"
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {owner.displayName ?? owner.email ?? owner.subject}
                    {owner.displayName && owner.email ? (
                      <span className="ml-2 font-normal text-gray-600 dark:text-gray-400">
                        {owner.email}
                      </span>
                    ) : null}
                  </p>
                  <p className="text-gray-700 dark:text-gray-300">{stateText(owner.state)}</p>
                </div>
                <dl className="flex shrink-0 gap-4 text-gray-600 sm:text-right dark:text-gray-400">
                  <div>
                    <dt className="text-xs uppercase tracking-wide">Last seen</dt>
                    <dd>{agoText(owner.lastSeenAt, now)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide">Agents on</dt>
                    <dd>{owner.agents}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide">Parked runs</dt>
                    <dd>
                      {owner.parkedRuns > 0 ? (
                        <Link
                          href="/admin/agents/queue?status=waiting"
                          className="text-blue-700 hover:underline dark:text-blue-400"
                        >
                          {owner.parkedRuns}
                        </Link>
                      ) : (
                        '0'
                      )}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
