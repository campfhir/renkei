import React from 'react';
import { redirect } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { keyStatusView } from '@/lib/keys/status';
import { PreferencesSectionBody } from '../section-body';
import EncryptionKeySection from '../encryption-key-section';

/** Preferences › Security: the encryption key your chats and agents' credentials are sealed with. */
export default async function SecurityPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/preferences/security`));
  // The delegate answers; unreachable, and there is nothing to show.
  const keyStatus = await keyStatusView(session);
  return (
    <PreferencesSectionBody
      title="Security"
      description="The key that keeps your chats and your agents’ credentials sealed."
    >
      {keyStatus ? (
        <EncryptionKeySection initial={keyStatus} />
      ) : (
        <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400">
          Your key&rsquo;s status could not be read right now. Try again in a moment.
        </p>
      )}
    </PreferencesSectionBody>
  );
}
