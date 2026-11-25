import React from 'react';
import { redirect } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { PreferencesSectionBody } from '../section-body';
import YourData from './your-data';

/**
 * Your data: export everything, or import chats and memories from another
 * assistant. A section of Preferences (Account), and reached from the
 * top-bar search: something done once in a while, not a setting to keep
 * in view.
 */
export default async function YourDataPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/preferences/data`));
  return (
    <PreferencesSectionBody
      title="Your data"
      description="Take your chats, memories and preferences with you, or bring them in from another assistant. Only you can export or import your own data."
    >
      <YourData />
    </PreferencesSectionBody>
  );
}
