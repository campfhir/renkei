/**
 * The projects and spaces a user could watch, for the picker.
 *
 * A free-text key field would be the smaller change, but it puts the user
 * back where the assistant was: guessing keys and reading provider errors.
 * Listing what they can actually see makes the choice self-validating.
 *
 * Deliberately not cached: which projects a person can see is exactly the
 * kind of thing that changes without Renkei being told.
 */

import { NextRequest, NextResponse } from 'next/server';
import { ATLASSIAN, ATLASSIAN_CONFLUENCE } from '@renkei/provider-grants';
import { atlassianFetch, listOf, str } from '@renkei/connector-atlassian';
import { getSessionFromRequest } from '@/lib/session';
import { getOrigin } from '@/lib/get-origin';
import { resolveAtlassianUserAccess } from '@/lib/atlassian-user-access';

export interface WatchOption {
  /** What gets stored as scope_key — a project key, or a space id. */
  key: string;
  label: string;
  /** Shown beside the label: project type, or space key. */
  hint: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const provider = request.nextUrl.searchParams.get('provider');
  if (provider !== 'jira' && provider !== 'confluence') {
    return NextResponse.json({ error: 'provider must be jira or confluence' }, { status: 400 });
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok)
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const access = await resolveAtlassianUserAccess(
    tenantId,
    session.subject,
    provider === 'jira' ? ATLASSIAN : ATLASSIAN_CONFLUENCE,
    originResult.val
  );
  if (typeof access === 'string') return NextResponse.json({ error: access }, { status: 400 });

  if (provider === 'jira') {
    const response = await atlassianFetch({
      product: 'jira',
      cloudId: access.cloudId,
      accessToken: access.accessToken,
      path: '/rest/api/3/project/search?maxResults=100&orderBy=key',
    });
    if (!response.ok) {
      return NextResponse.json(
        {
          error:
            response.status === 401 || response.status === 403
              ? 'Your Jira connection cannot list projects yet — the project endpoints require a ' +
                'scope that was missing from Renkei until recently. Reconnect Jira to pick it up. ' +
                'Watching works either way; enter a project key below.'
              : `Jira answered ${response.status}.`,
        },
        { status: 400 }
      );
    }
    const options: WatchOption[] = listOf(response.body, 'values').map((project) => ({
      key: str(project.key),
      label: str(project.name) || str(project.key),
      hint: str(project.projectTypeKey),
    }));
    return NextResponse.json({ options });
  }

  const response = await atlassianFetch({
    product: 'confluence',
    cloudId: access.cloudId,
    accessToken: access.accessToken,
    path: '/wiki/api/v2/spaces?limit=100&status=current',
  });
  if (!response.ok) {
    return NextResponse.json({ error: `Confluence answered ${response.status}.` }, { status: 400 });
  }
  const options: WatchOption[] = listOf(response.body, 'results').map((space) => ({
    // Space ID, not key: it is what the v2 page listing the poller uses
    // filters on.
    key: str(space.id),
    label: str(space.name) || str(space.key),
    hint: str(space.key),
  }));
  return NextResponse.json({ options });
}
