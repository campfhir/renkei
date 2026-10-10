import { requireAuth } from '@/lib/require-auth';
import { searchLogs } from './actions';
import LogsViewer from './logs-viewer';
import { defaultLogWindow, DEFAULT_LOG_LEVELS } from './window';

/**
 * Server-render the first page of logs, then hand off to the viewer, which
 * calls `searchLogs` for every subsequent filter change. Role and scope are
 * resolved inside that action, so there is nothing to decide here.
 */
export default async function LogsPage({ searchParams }: {
  searchParams: Promise<{ accountId?: string }>;
}) {
  const { accountId } = await searchParams;

  await requireAuth(`/logs`);

  // Computed here, not in both places: the server render and the picker the
  // client seeds from have to agree about what is being searched.
  const window = defaultLogWindow();

  const initial = await searchLogs({
    expr: null,
    levels: DEFAULT_LOG_LEVELS,
    start: window.start,
    end: window.end,
    sort: 'desc',
    accountId: accountId ?? null,
  });

  return (
    <LogsViewer
      accountId={accountId ?? null}
      initial={initial}
      initialWindow={window}
    />
  );
}
