import React from 'react';
import { LogsClientApp } from '@/lib/ui/admin/logs-client-app';
import { getOperatorSession } from '@/lib/auth-utils';
import { redirect } from 'next/navigation';

export default async function LogsPage({ params }: { params: Promise<{ slug: string }> }): Promise<React.ReactNode> {
  const session = await getOperatorSession();
  const { slug } = await params;

  if (!session) {
    redirect(`/admin/${slug}`);
  }

  return (
    <div>
      <h2>Error Logs</h2>
      <p>System logs for API errors, authentication failures, and rate limit events.</p>
      <LogsClientApp tenantSlug={slug} />
    </div>
  );
}
