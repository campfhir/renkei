import { redirect } from 'next/navigation';
import { signInUrl } from '@/lib/sign-in-url';
import { searchLogs } from './actions';
import LogsViewer from './logs-viewer';
import { defaultLogWindow } from './window';

/**
 * Server-render the first page of logs, then hand off to the viewer, which
 * calls `searchLogs` for every subsequent filter change. Role and scope are
 * resolved inside that action, so there is nothing to decide here.
 */
export default async function LogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ accountId?: string }>;
}) {
  const { tenantId } = await params;
  const { accountId } = await searchParams;

  // Computed here, not in both places: the server render and the picker the
  // client seeds from have to agree about what is being searched.
  const window = defaultLogWindow();

  const initial = await searchLogs(tenantId, {
    expr: null,
    levels: [],
    start: window.start,
    end: window.end,
    sort: 'desc',
    accountId: accountId ?? null,
  });

  // The proxy only checks that a session cookie exists, so arriving here with a
  // dead one is normal. Send them to authenticate rather than rendering a page
  // that says "sign in" without being able to start it.
  if (initial.signedOut) {
    redirect(signInUrl(tenantId, `/tenant/${tenantId}/logs`));
  }

  return (
    <LogsViewer
      tenantId={tenantId}
      accountId={accountId ?? null}
      initial={initial}
      initialWindow={window}
    />
  );
}
