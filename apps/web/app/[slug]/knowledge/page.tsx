import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import KnowledgeSearch from './search';

/**
 * Self-service search over what Renkei has indexed — the human-facing twin
 * of the `search_knowledge` MCP tool. No admin gate: every signed-in user
 * can search, and the searching identity comes from their own session, so
 * results are always their own view (see actions.ts for the enforcement).
 */
export default async function KnowledgePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/knowledge`));
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Knowledge search</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Semantic search over what Renkei has indexed from your connected tools. Every result is
        verified against the source system for your own access before it's shown — anything you
        couldn't open there is withheld, not just hidden.
      </p>
      <KnowledgeSearch tenantId={tenant.id} />
    </div>
  );
}
