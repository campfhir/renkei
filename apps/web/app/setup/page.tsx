import { redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { SETUP_SECRET_ENV, SETUP_SECRET_MIN_CHARS, setupState } from '@/lib/setup-secret';
import SetupForm from './setup-form';

export const dynamic = 'force-dynamic';

/**
 * First-run setup: configuring the identity provider before anyone can sign
 * in. The form posts to api/oidc with the SETUP_SECRET from the app's
 * environment (lib/setup-secret.ts), the only credential that can exist
 * before the first operator does; without one set, the page says how to
 * set it instead of offering a form nothing could submit. Once a provider
 * is configured the page is gone: sign-in is the way in.
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
  const state = await setupState(dbResult.val);
  if (state === 'configured') redirect('/');

  if (state !== 'ready') {
    return (
      <div className="flex min-h-screen items-start justify-center bg-gray-50 px-4 py-16 dark:bg-black">
        <main className="w-full max-w-xl">
          <h1 className="mb-2 text-2xl font-bold">Set up Renkei</h1>
          <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
            This deployment has no identity provider yet, so nobody can sign in. Configuring one
            needs a setup secret, and{' '}
            {state === 'unset' ? (
              <>
                none is set: add <code className="text-xs">{SETUP_SECRET_ENV}</code> to the
                app&apos;s environment
              </>
            ) : (
              <>
                the one set is too short: give <code className="text-xs">{SETUP_SECRET_ENV}</code>{' '}
                at least {SETUP_SECRET_MIN_CHARS} characters
              </>
            )}{' '}
            (<code className="text-xs">openssl rand -base64 32</code> makes a good one), restart
            the app and reload this page. The secret is only needed once; remove it after the
            identity provider is saved.
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-gray-50 px-4 py-16 dark:bg-black">
      <main className="w-full max-w-xl">
        <h1 className="mb-2 text-2xl font-bold">Set up Renkei</h1>
        <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
          This deployment has no identity provider yet, so nobody can sign in. Connect the
          organization&apos;s OpenID Connect provider below and enter the setup secret from the
          app&apos;s environment (<code className="text-xs">{SETUP_SECRET_ENV}</code>).
        </p>
        <SetupForm />
      </main>
    </div>
  );
}
