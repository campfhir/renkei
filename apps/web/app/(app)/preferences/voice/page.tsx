import React from 'react';
import { redirect } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { loadVoiceAvailability } from '@/lib/voice/availability';
import { PreferencesSectionBody } from '../section-body';
import VoiceForm from '../voice-form';

/** Preferences › Voice: the voice that reads replies and the language it listens for. */
export default async function VoicePage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/preferences/voice`));
  // Null when the org has no voice service.
  const voice = await loadVoiceAvailability(session.subject);
  return (
    <PreferencesSectionBody
      title="Voice"
      description="The voice that reads replies aloud, its pace, and the language it listens for."
    >
      {voice ? (
        <VoiceForm
          initial={voice.prefs}
          defaults={{ voice: voice.defaultVoice, locale: voice.defaultLocale }}
        />
      ) : (
        <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400">
          Your organization has no voice service set up, so there is nothing to choose here yet.
        </p>
      )}
    </PreferencesSectionBody>
  );
}
