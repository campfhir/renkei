import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listAccessibleLibraries } from '@/lib/chat/prompts';
import LibrariesIndex from '../_components/libraries-index';

/** Prompt libraries: mine, shared with me, published to the organization. */
export default async function PromptLibrariesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/chat/prompts`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const libraries = await listAccessibleLibraries(dbResult.val, tenant.id, session.subject);
  return (
    <LibrariesIndex
      slug={slug}
      tenantId={tenant.id}
      libraries={libraries.map(({ library, role }) => ({
        id: library.id,
        name: library.name,
        description: library.description,
        publishedToOrg: library.publishedToOrg,
        role,
      }))}
    />
  );
}
