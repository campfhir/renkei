import { requireAuth } from '@/lib/require-auth';
import { getUsageReport, getAvailableTools } from './actions';
import UsageViewer from './usage-viewer';

/**
 * Server-render the default window, then hand off to the viewer, which calls
 * `getUsageReport` for every period change. Scope is decided inside the action
 * from the session, so there is nothing to decide here.
 *
 * The tool catalog is fetched once: it answers "what do you have", which does
 * not vary with the period being charted.
 */
export default async function UsagePage() {
  await requireAuth(`/usage`);

  const [initial, tools] = await Promise.all([
    getUsageReport(7),
    getAvailableTools(),
  ]);

  return <UsageViewer initial={initial} tools={tools} />;
}
