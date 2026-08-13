import { redirect } from 'next/navigation';

/**
 * `/{slug}/home` moved to `/{slug}` — the tenant root IS the feed, so the
 * extra segment said nothing.
 *
 * This redirect stays because the old path is in the wild: WebEx messages
 * the bot has already posted link to it, as do the OIDC callback and the
 * home-realm route, and a bookmark costs nothing to honour. The query string
 * rides along so an `?archived=1` link keeps working.
 */
export default async function HomeRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const { slug } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === 'string') query.set(key, value);
    else if (Array.isArray(value)) for (const entry of value) query.append(key, entry);
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  redirect(`/${slug}${suffix}`);
}
