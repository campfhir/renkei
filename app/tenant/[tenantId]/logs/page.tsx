import { Suspense } from 'react';
import { cookies } from 'next/headers';
import { getDatabase } from '@/lib/db';
import { PostgresAdapter } from '@campfhir/bored-logs/adapters/psql';
import { buildLogQueryOptions } from '@/lib/log-query';
import { parseRolesFromCookie } from '@/lib/oidc-roles';
import LogsViewerContent from '../logs-viewer';

async function fetchInitialLogs(
  tenantId: string,
  accountId: string | null,
  query: string | null
) {
  try {
    const cookieStore = await cookies();
    const userRolesStr = cookieStore.get(`oidc_roles_${tenantId}`)?.value;
    const userRoles = parseRolesFromCookie(userRolesStr);

    let userRole = null;
    if (userRoles.has('renkei-operator')) {
      userRole = 'renkei-operator';
    } else if (userRoles.has('renkei-user')) {
      userRole = 'renkei-user';
    }

    const db = getDatabase();
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return { logs: [], role: null, error: 'Tenant not found' };
    }

    const queryOptions = buildLogQueryOptions(query, tenantId, accountId || undefined);
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
}) {
  const { tenantId } = await params;
  const { accountId, q } = await searchParams;

  const { logs: initialLogs, role: initialRole, error: initialError } = await fetchInitialLogs(
    tenantId,
    accountId || null,
    q || null
  );

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
