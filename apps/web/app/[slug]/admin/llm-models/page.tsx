import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import ModelForms from './model-forms';

/**
 * Org-admin configuration of the models user-drafted agents run on
 * (llm_model_configs). Bring-your-own is the platform posture (Decision
 * #8): this page holds credentials to someone else's model, never a model.
 * Keys are write-only — the API reports presence, a blank field keeps the
 * stored one — and exactly one model is the org default agents fall back
 * to when they don't pin one.
 */
export default async function AdminLlmModelsPage({
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
      <h1 className="mb-1 text-xl font-bold">Agent models</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        The models user-drafted agents run on, with your organization&apos;s own API keys. Agents
        use the default model unless their owner picks another from this list. Without at least one
        enabled model, agents cannot run and no saved-agent summaries are generated.
      </p>
      <ModelForms slug={slug} />
    </div>
  );
}
