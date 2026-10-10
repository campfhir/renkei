import { redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { ensureSetupSecret } from '@/lib/setup-secret';
import { getOrigin } from '@/lib/get-origin';
import SetupForm from './setup-form';

export const dynamic = 'force-dynamic';

/**
 * First-run setup: configuring the identity provider before anyone can sign
 * in. Opening the page mints the one-time setup secret into the server log
 * (lib/setup-secret.ts) when no live one exists; the form posts to
 * api/oidc with that secret, which is the only credential that can exist
 * before the first operator does. Once a provider is configured the page
 * is gone: sign-in is the way in.
 */
export default async function SetupPage() {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return (
      <main className="mx-auto max-w-lg px-4 py-16">
        <h1 className="mb-2 text-2xl font-bold">Renkei setup</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          The database is not reachable. Check DATABASE_URL and that the migrations have run,
          then reload this page.
        </p>
      </main>
    );
  }
  const originResult = await getOrigin();
  const base = originResult.ok ? originResult.val : '';
  const state = await ensureSetupSecret(dbResult.val, `${base}/setup`);
  if (state === 'configured') redirect('/');

  return (
    <div className="flex min-h-screen items-start justify-center bg-gray-50 px-4 py-16 dark:bg-black">
      <main className="w-full max-w-xl">
        <h1 className="mb-2 text-2xl font-bold">Set up Renkei</h1>
        <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
          This deployment has no identity provider yet, so nobody can sign in. Connect the
          organization&apos;s OpenID Connect provider below. The setup secret was just written to
          the server log; copy it from there.
        </p>
        <SetupForm />
      </main>
    </div>
  );
}
