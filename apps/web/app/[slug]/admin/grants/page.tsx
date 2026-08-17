import { redirect } from 'next/navigation';

/**
 * Grants folded into People: "who is connected to what" is a fact about a
 * person, and the old page only knew about Jira anyway. Kept as a redirect
 * so bookmarks and muscle memory land somewhere useful.
 */
export default async function GrantsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<never> {
  const { slug } = await params;
  redirect(`/${slug}/admin/people`);
}
