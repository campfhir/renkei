import React from 'react';
import { Suspense } from 'react';
import { getDatabase } from '@/lib/db';
import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql';
import { buildLogQueryOptions } from '@/lib/log-query';
import { getSessionFromCookies } from '@/lib/session';
import LogsViewerContent from '../logs-viewer';

async function fetchInitialLogs(
  tenantId: string,
  requestedAccountId: string | null,
  query: string | null
) {
  try {
    const session = await getSessionFromCookies(tenantId);
    if (!session) {
      return { logs: [], role: null, error: 'Not signed in' };
    }

    const userRoles = new Set(session.roles);
    let userRole = null;
    let isOperator = false;
    if (userRoles.has('renkei-operator')) {
      userRole = 'renkei-operator';
      isOperator = true;
    } else if (userRoles.has('renkei-user')) {
      userRole = 'renkei-user';
    }

    const dbResult = getDatabase();
    if (!dbResult.ok) {
      return { logs: [], role: null, error: 'Failed to connect to database' };
    }
    const db = dbResult.val;
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return { logs: [], role: null, error: 'Tenant not found' };
    }

    // This user's own Jira account, resolved via the grant they personally
    // connected. Keyed on subject rather than "first grant in the tenant", which
    // would have shown one user another user's activity.
    const currentGrant = await db
      .selectFrom('provider_grants')
      .select('provider_account_id')
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', 'atlassian')
      .where('subject', '=', session.subject)
      .executeTakeFirst();

    const currentUserAccountId = currentGrant?.provider_account_id || null;

    // Determine which accountId to filter by:
    // - Non-operators: always their own accountId (ignore requestedAccountId)
    // - Operators: requested accountId if provided, otherwise their own
    const filterAccountId = !isOperator
      ? currentUserAccountId
      : requestedAccountId || currentUserAccountId;

    const queryOptions = buildLogQueryOptions(query, tenantId, filterAccountId || undefined);
    const adapter = new PostgresAdapter({ db });

    try {
      await adapter.migrate();
    } catch {
      // Schema may already exist
    }

    const result = await adapter.query(queryOptions);

    if (!result.ok) {
      return { logs: [], role: userRole, error: result.err.message || 'Failed to fetch logs' };
    }

    return {
      logs: result.val,
      role: userRole,
      error: null,
    };
  } catch (error) {
    console.error('Failed to fetch initial logs:', error);
    return {
      logs: [],
      role: null,
      error: 'Failed to fetch logs',
    };
  }
}

export default async function LogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ accountId?: string; q?: string }>;
}): Promise<React.ReactNode> {
  const { tenantId } = await params;
  const { accountId, q } = await searchParams;

  const {
    logs: initialLogs,
    role: initialRole,
    error: initialError,
  } = await fetchInitialLogs(tenantId, accountId || null, q || null);

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-screen">
          <p className="text-gray-600 dark:text-gray-400">Loading...</p>
        </div>
      }
    >
      <LogsViewerContent
        initialLogs={initialLogs}
        initialRole={initialRole}
        initialError={initialError}
      />
    </Suspense>
  );
}
