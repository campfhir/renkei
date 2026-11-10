import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import YourData from './your-data';

/**
 * Your data: export everything, or import chats and memories from another
 * assistant. Its own page, reached from the foot of Preferences and the
 * top-bar search, because it is something done once in a while, not a
 * setting to keep in view.
 */
export default async function YourDataPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/preferences/data`));
  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/preferences"
        className="text-sm text-blue-600 hover:underline dark:text-blue-400"
      >
        ← Preferences
      </Link>
      <h1 className="mb-1 mt-2 text-xl font-bold">Your data</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Take your chats, memories and preferences with you, or bring them in from another assistant.
        Only you can export or import your own data.
      </p>
      <YourData />
    </div>
  );
}
