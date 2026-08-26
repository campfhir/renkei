/**
 * People from the Microsoft 365 directory, for the trigger-filter sender
 * picker.
 *
 * A HELPER, never a gate. Mail filters match on an address, and plenty of
 * addresses a person legitimately wants to filter on are not in their
 * directory at all — a customer, a vendor, an alias. So the picker exists
 * to save typing when the directory happens to know somebody, and the field
 * accepts any address typed by hand either way.
 *
 * `key` is the ADDRESS, not the Graph id, because that is what the event
 * payload carries and therefore what the filter compares. Storing the id
 * would produce a filter that looks right and matches nothing.
 *
 * The query, its required header and its $select live in
 * lib/mcp-tools/graph/directory.ts, shared with outlook_search_users.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { getOrigin } from '@/lib/get-origin';
import { resolveGraphAccess, str } from '@/lib/mcp-tools/graph/client';
import { addressOf, searchDirectoryUsers } from '@/lib/mcp-tools/graph/directory';

const RESULT_MAX = 25;

export interface PersonOption {
  /** The address the filter stores and compares. */
  key: string;
  label: string;
  hint: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const query = (request.nextUrl.searchParams.get('q') ?? '').trim();
  // Graph's $search needs something to search for. An empty result with no
  // error is the honest answer: the picker then says "type a name", rather
  // than showing a provider error for a question nobody asked.
  if (!query) return NextResponse.json({ options: [] });

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const context = { tenantId, subject: session.subject, origin: originResult.val };
  const access = await resolveGraphAccess(context);
  if (typeof access === 'string') {
    return NextResponse.json({ error: access }, { status: 400 });
  }

  const found = await searchDirectoryUsers(context, access.accessToken, query, RESULT_MAX);
  if (typeof found === 'string') return NextResponse.json({ error: found }, { status: 400 });

  const options: PersonOption[] = found
    .map((user) => ({
      key: addressOf(user).toLowerCase(),
      label: str(user.displayName) || addressOf(user),
      hint: str(user.department) || str(user.jobTitle),
    }))
    // A directory entry with no address cannot be filtered on, so offering
    // it would be offering a choice that silently does nothing.
    .filter((option) => option.key !== '');

  return NextResponse.json({ options });
}
