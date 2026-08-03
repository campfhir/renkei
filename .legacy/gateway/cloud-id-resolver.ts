/**
 * Resolve a Jira cloud ID from a Jira domain URL.
 *
 * Users provide a Jira URL (e.g., https://mycompany.atlassian.net), and we
 * fetch the cloud ID from the /_edge/tenant_info endpoint. If that fails,
 * we try fetching the URL directly in case it's served from a different path.
 */

import type { FetchLike } from '../auth/atlassian.js';

export interface TenantInfo {
  cloudId: string;
}

const CLOUD_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Fetch the cloud ID from a Jira URL.
 *
 * Tries the URL with /_edge/tenant_info path first, then falls back to
 * fetching the root URL if the first attempt fails. Whatever comes back has
 * to be shaped like a cloud ID — a wrong or hijacked domain answering with
 * unrelated JSON must not silently mint a bogus site.
 */
export async function resolveCloudId(
  jiraUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  // Normalize: remove trailing slashes
  let url = jiraUrl.trim().replace(/\/$/, '');

  // Ensure it has a protocol
  if (!url.match(/^https?:\/\//i)) {
    url = `https://${url}`;
  }

  const errors: string[] = [];

  async function tryUrl(target: string, label: string): Promise<string | null> {
    try {
      const response = await fetchImpl(target, {
        headers: {
          'User-Agent': 'Renkei/1.0',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        errors.push(`${label} returned ${response.status}`);
        return null;
      }

      const data = (await response.json()) as TenantInfo;
      if (typeof data.cloudId !== 'string' || !CLOUD_ID_SHAPE.test(data.cloudId)) {
        errors.push(`${label} returned no valid cloudId: ${JSON.stringify(data)}`);
        return null;
      }

      return data.cloudId;
    } catch (e) {
      errors.push(`${label} fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  const fromTenantInfo = await tryUrl(`${url}/_edge/tenant_info`, '/_edge/tenant_info');
  if (fromTenantInfo !== null) return fromTenantInfo;

  const fromRoot = await tryUrl(url, 'Root URL');
  if (fromRoot !== null) return fromRoot;

  throw new Error(
    `Unable to resolve cloud ID from Jira URL "${url}". ` +
      `Please verify the URL is correct and publicly accessible. ` +
      `Details: ${errors.join('; ')}`,
  );
}
