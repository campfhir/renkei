/**
 * Where an issue can be opened — both places, when there are two.
 *
 * A Jira Service Management ticket lives at two URLs that are not
 * interchangeable: `/browse/ENG-789`, which agents can open and customers
 * cannot, and the customer portal request, which is what a reporter is
 * meant to be sent. Replies used to offer only the browse link, so anything
 * passed on to a requester was a link they had no licence to open.
 *
 * Which one applies is a property of the PROJECT, not the issue, so it is
 * looked up once per project and cached: project types effectively never
 * change, and decorating a link must not cost a request per reply.
 *
 * A failed lookup yields the browse link alone. Guessing the other way
 * would hand out a portal URL that 404s for every ordinary Jira project.
 *
 * (Named issue-urls, not issue-links: `issue-links.ts` is the tools for
 * linking issues TO EACH OTHER, which is a different thing entirely.)
 */

import { granularJiraScopes, type JiraAuth } from './jira-auth';
import { issueUrl, requestUrl } from '../common';

interface CacheEntry {
  serviceDesk: boolean;
  expiresAt: number;
}

const CACHE_TTL_MS = 60 * 60_000;
const cache = new Map<string, CacheEntry>();

/** `ENG-789` → `ENG`. Jira guarantees the key is the project prefix. */
export function projectKeyOf(issueKey: string): string {
  const dash = issueKey.lastIndexOf('-');
  return dash > 0 ? issueKey.slice(0, dash) : issueKey;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Does this project serve a customer portal? Never throws — decorating a
 * link is not worth failing a write that already succeeded.
 */
export async function isServiceDeskProject(
  siteUrl: string,
  auth: JiraAuth,
  projectKey: string
): Promise<boolean> {
  const key = `${siteUrl}:${projectKey.toUpperCase()}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.serviceDesk;

  let serviceDesk = false;
  try {
    const response = await auth.fetch(
      granularJiraScopes('jira_list_projects', true),
      `/rest/api/3/project/${encodeURIComponent(projectKey)}`
    );
    if (response.ok) {
      const body: unknown = await response.json().catch(() => null);
      if (isRecord(body) && body.projectTypeKey === 'service_desk') serviceDesk = true;
    }
  } catch {
    // Leave it false: browse-only is always a valid answer.
  }

  cache.set(key, { serviceDesk, expiresAt: now + CACHE_TTL_MS });
  return serviceDesk;
}

export interface IssueLinkTarget {
  label: string;
  url: string;
}

/**
 * The links for an issue, agent view first.
 *
 * Both are returned for a service-desk ticket because both audiences are
 * real: whoever is working it needs the Jira view, and whoever reported it
 * can only use the portal.
 */
export async function issueLinkTargets(
  siteUrl: string,
  auth: JiraAuth,
  issueKey: string
): Promise<IssueLinkTarget[]> {
  const links: IssueLinkTarget[] = [{ label: 'Open in Jira', url: issueUrl(siteUrl, issueKey) }];
  if (await isServiceDeskProject(siteUrl, auth, projectKeyOf(issueKey))) {
    links.push({ label: 'Customer portal', url: requestUrl(siteUrl, issueKey) });
  }
  return links;
}

/** The same links as the markdown suffix replies already use. */
export async function issueLinksMarkdown(
  siteUrl: string,
  auth: JiraAuth,
  issueKey: string
): Promise<string> {
  const links = await issueLinkTargets(siteUrl, auth, issueKey);
  return links.map((link) => `[${link.label}](${link.url})`).join(' · ');
}

/** Test seam. */
export function clearProjectTypeCache(): void {
  cache.clear();
}
