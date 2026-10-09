import { redirect } from 'next/navigation';

/**
 * Grants are now the Access page — the same "who is connected to what",
 * as one table. Kept as a redirect so bookmarks and muscle memory land
 * somewhere useful.
 */
export default async function GrantsPage(): Promise<never> {
  redirect(`/admin/access`);
}
