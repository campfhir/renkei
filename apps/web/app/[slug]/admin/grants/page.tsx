import { redirect } from 'next/navigation';

/**
 * Grants folded into People, and People since folded into Organization
 * usage: "who is connected to what" is a fact about a person, and a
 * person is now looked at on the usage page. Kept as a redirect so
 * bookmarks and muscle memory land somewhere useful.
 */
export default async function GrantsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<never> {
  const { slug } = await params;
  redirect(`/${slug}/admin/usage`);
}
