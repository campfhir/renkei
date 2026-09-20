import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import ProjectTemplateForms from './project-template-forms';

/**
 * The org's catalog of code-project templates (code_project_templates):
 * starting instructions offered on the new-code-project form. Every
 * tenant starts with a few seeded rows; an operator can rename, rewrite
 * or delete any of them. Picking one only fills the instructions
 * textarea there — it stays fully editable, so this catalog is a set of
 * starting points, not a policy that is enforced.
 */
export default async function AdminProjectTemplatesPage({
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
      <h1 className="mb-1 text-xl font-bold">Project templates</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        What the instructions field offers to start from when someone creates a code project. Add,
        rewrite or delete any of these freely — whatever is picked stays fully editable on the
        project itself afterward.
      </p>
      <ProjectTemplateForms slug={slug} />
    </div>
  );
}
