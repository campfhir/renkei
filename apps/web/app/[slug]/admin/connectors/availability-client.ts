/**
 * Saving the org-wide off switches. Shared by the catalog list and each
 * connector's own page, both of which hold the whole set — the route
 * replaces the list, so a caller must send everything it knows.
 */
export async function saveDisabledConnectors(
  slug: string,
  disabled: ReadonlySet<string>
): Promise<string | null> {
  try {
    const response = await fetch(`/api/admin/${slug}/connector-availability`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabledConnectors: [...disabled] }),
    });
    if (response.ok) return null;
    const body: unknown = await response.json().catch(() => null);
    return typeof body === 'object' && body !== null && 'error' in body
      ? String(body.error)
      : 'Could not save';
  } catch {
    return 'Could not reach the server.';
  }
}
