'use client';

import { useEffect, useState } from 'react';

interface Grant {
  id: string;
  granteeName: string | null;
  granteeEmail: string | null;
  expiresAt: string | null;
  expired: boolean;
}

export default function SharedWithPanel({
  tenantId,
  agentId,
}: {
  tenantId: string;
  agentId: string;
}) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetch(`/api/tenant/${tenantId}/agents/${agentId}/access`);
        if (!response.ok) {
          setError('Could not load access grants');
          return;
        }
        const data: { grants?: Grant[] } = await response.json().catch(() => ({}));
        setGrants(data.grants ?? []);
      } catch {
        setError('Could not load access grants');
      }
    };
    void load();
  }, [tenantId, agentId]);

  if (error) {
    return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  }

  if (grants === null) {
    return <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>;
  }

  const activeGrants = grants.filter((g) => !g.expired);
  const expiredGrants = grants.filter((g) => g.expired);

  if (grants.length === 0) {
    return (
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Nobody has access yet. Use the <span className="font-medium">Share</span> button above to
        grant access.
      </p>
    );
  }

  const personLabel = (name: string | null, email: string | null): string => {
    return name ? `${name} (${email ?? '?'})` : (email ?? '?');
  };

  return (
    <div className="space-y-3">
      {activeGrants.length > 0 ? (
        <div>
          <p className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-400">
            {activeGrants.length} {activeGrants.length === 1 ? 'colleague' : 'colleagues'} can read
            and edit this agent
          </p>
          <ul className="divide-y divide-gray-100 dark:divide-gray-900">
            {activeGrants.map((grant) => (
              <li key={grant.id} className="py-2 text-sm">
                <div className="block truncate text-gray-800 dark:text-gray-200">
                  {personLabel(grant.granteeName, grant.granteeEmail)}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {grant.expiresAt
                    ? `Until ${new Date(grant.expiresAt).toLocaleDateString()}`
                    : 'Permanent access'}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {expiredGrants.length > 0 ? (
        <div>
          <p className="mb-2 text-xs font-semibold text-amber-600 dark:text-amber-400">
            {expiredGrants.length} expired {expiredGrants.length === 1 ? 'grant' : 'grants'}
          </p>
          <ul className="divide-y divide-gray-100 dark:divide-gray-900 opacity-60">
            {expiredGrants.map((grant) => (
              <li key={grant.id} className="py-2 text-sm text-gray-500 dark:text-gray-400">
                <div className="block truncate">
                  {personLabel(grant.granteeName, grant.granteeEmail)}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
