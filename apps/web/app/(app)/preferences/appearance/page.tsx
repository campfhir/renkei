import React from 'react';
import { redirect } from 'next/navigation';
import { getThemePrefs } from '@renkei/user-prefs';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { PreferencesSectionBody } from '../section-body';
import ThemeForm from '../theme-form';

/** Preferences › Appearance: the theme, and line numbers in code blocks. */
export default async function AppearancePage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/preferences/appearance`));
  const theme = await getThemePrefs(session.subject, { fresh: true });
  return (
    <PreferencesSectionBody
      title="Appearance"
      description="How Renkei looks on this and every other device you sign into."
    >
      <ThemeForm initial={theme} />
    </PreferencesSectionBody>
  );
}
