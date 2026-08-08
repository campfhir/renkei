import React from 'react';
import { LogsClientApp } from '@/lib/ui/admin/logs-client-app';
import { getOperatorAccess } from '@/lib/operator-access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { redirect, notFound } from 'next/navigation';

export default async function LogsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) notFound();
  if (!(await getOperatorAccess(tenantRef.id))) {
    redirect(`/${slug}/admin`);
  }

  return (
    <div>
      <h2>Error Logs</h2>
      <p>System logs for API errors, authentication failures, and rate limit events.</p>
      <LogsClientApp tenantSlug={slug} />
    </div>
  );
}
