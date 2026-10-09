import type { Metadata } from 'next';
import { getDatabase } from '@renkei/db';
import RenkeiMark from '@/components/renkei-mark';
import { getSessionFromCookies } from '@/lib/session';
import { describeRedirectTarget } from '@/lib/oauth-redirect-uri';

/**
 * The consent page of the MCP OAuth flow: the one screen between a
 * signed-in person and a client acting as them. The authorize endpoint
 * (api/mcp/[tenantId]/oauth/authorize) sends the browser here with the id
 * of the request it recorded against this session; the page names the
 * client, says where its code would go and as whom it would act, and the
 * two buttons POST the answer straight back to that endpoint, which checks
 * the same session is answering. No client-side code: a plain form, so the
 * page works the same with scripts off and has nothing to hydrate.
 *
 * Routed outside `[slug]` on purpose: the request row names the tenant,
 * and the person reaches this page from a client, not from the app's
 * navigation.
 */

export const metadata: Metadata = { title: 'Authorize application' };
export const dynamic = 'force-dynamic';

const RECENTLY_REGISTERED_MS = 60 * 60_000;

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string | string[] }>;
}) {
  const { request } = await searchParams;
  const requestId = typeof request === 'string' ? request : undefined;
  if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) {
    return (
      <Notice
        title="Nothing to authorize"
        body="This page is reached from an application asking to connect; open it from there."
      />
    );
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return <Notice title="Try again shortly" body="The service could not read this request." />;
  }
  const db = dbResult.val;

  const pending = await db
    .selectFrom('oauth_consent_requests as r')
    .innerJoin('oauth_clients as c', 'c.client_id', 'r.client_id')
    .innerJoin('tenants as t', 't.id', 'r.tenant_id')
    .select([
      'r.id',
      'r.tenant_id',
      'r.session_id',
      'r.subject',
      'r.redirect_uri',
      'r.scope',
      'r.expires_at',
      'c.client_name',
      'c.created_at as client_created_at',
      't.slug',
    ])
    .where('r.id', '=', requestId)
    .executeTakeFirst();

  if (!pending || new Date(pending.expires_at) < new Date()) {
    return (
      <Notice
        title="This request has expired"
        body="Go back to the application and connect again; you will be brought here with a fresh request."
      />
    );
  }

  const session = await getSessionFromCookies(pending.tenant_id);
  if (!session || session.id !== pending.session_id) {
    return (
      <Notice
        title="Sign in to continue"
        body="This request was started from a different browser session. Go back to the application and connect again from the browser you are signed in with."
      />
    );
  }

  const identity = await db
    .selectFrom('identities')
    .select(['email', 'display_name'])
    .where('tenant_id', '=', pending.tenant_id)
    .where('subject', '=', pending.subject)
    .executeTakeFirst();

  const clientName = pending.client_name?.trim() || 'An application';
  const target = describeRedirectTarget(pending.redirect_uri);
  const registeredAgoMs = Date.now() - new Date(pending.client_created_at).getTime();
  const recentlyRegistered = registeredAgoMs < RECENTLY_REGISTERED_MS;
  const who = identity?.display_name
    ? `${identity.display_name} (${identity.email})`
    : (identity?.email ?? pending.subject);

  return (
    <main className="flex min-h-full flex-1 items-center justify-center bg-background px-4 py-10 text-foreground">
      <form
        method="post"
        action={`/api/mcp/${pending.tenant_id}/oauth/authorize`}
        className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-950"
      >
        <input type="hidden" name="request" value={pending.id} />
        <div className="mb-5 flex items-center gap-3">
          <RenkeiMark className="h-8 w-8" title="Renkei" />
          <div>
            <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
              {pending.slug}
            </p>
            <h1 className="text-lg font-semibold">Allow {clientName} to act as you?</h1>
          </div>
        </div>

        <dl className="mb-5 space-y-3 text-sm">
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Signed in as</dt>
            <dd className="font-medium break-all">{who}</dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">It will be able to</dt>
            <dd>
              Use Renkei&apos;s tools with your permissions: the connectors you have connected and
              the knowledge you can see. It cannot do anything you cannot.
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Its access goes to</dt>
            <dd className="font-medium break-all">{target}</dd>
          </div>
        </dl>

        {recentlyRegistered && (
          <p
            role="note"
            className="mb-5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          >
            This application registered itself less than an hour ago. If you did not just set it up
            yourself, choose Deny.
          </p>
        )}

        <p className="mb-5 text-sm text-gray-600 dark:text-gray-400">
          You can end this access at any time from the Access page, or by asking an administrator to
          sign you out everywhere.
        </p>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="submit"
            name="decision"
            value="deny"
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900"
          >
            Deny
          </button>
          <button
            type="submit"
            name="decision"
            value="allow"
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Allow
          </button>
        </div>
      </form>
    </main>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-950">
        <div className="mb-4 flex items-center gap-3">
          <RenkeiMark className="h-8 w-8" title="Renkei" />
          <h1 className="text-lg font-semibold">{title}</h1>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400">{body}</p>
      </div>
    </main>
  );
}
