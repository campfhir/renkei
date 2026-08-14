import { redirect, notFound } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { signInUrl } from '@/lib/sign-in-url';
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
export default async function UsagePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const [initial, tools] = await Promise.all([
    getUsageReport(tenant.id, 7),
    getAvailableTools(tenant.id),
  ]);

  // Arriving with a dead session cookie is normal. Send them to authenticate
  // rather than rendering a page that says "sign in" without offering it.
  if (initial.signedOut) {
    redirect(signInUrl(tenant.id, `/${slug}/usage`));
  }

  return <UsageViewer slug={slug} tenantId={tenant.id} initial={initial} tools={tools} />;
}
