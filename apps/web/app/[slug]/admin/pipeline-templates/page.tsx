import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import PipelineTemplateForms from './pipeline-template-forms';

/**
 * The org's catalog of pipeline templates (pipeline_templates): starting
 * pipeline files offered on a code project's Pipelines page when its
 * repository has none. Every tenant starts with a few seeded rows; an
 * operator can rename, rewrite or delete any of them. Picking one only
 * fills the editor there — the text is committed as the person leaves
 * it — so this catalog is a set of starting points, not a policy.
 */
export default async function AdminPipelineTemplatesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) notFound();
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    redirect(`/${slug}/admin`);
  }
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Pipeline templates</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        What a code project’s Pipelines page offers to start a{' '}
        <span className="font-mono">bitbucket-pipelines.yml</span> from when its repository has
        none. Add, rewrite or delete any of these freely — whatever is picked is edited on the page
        before it is committed.
      </p>
      <PipelineTemplateForms slug={slug} />
    </div>
  );
}
