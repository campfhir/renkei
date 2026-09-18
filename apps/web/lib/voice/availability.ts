/**
 * What a chat page needs to know about voice before anything is clicked:
 * whether the org has it at all, and how this person has it set up. The
 * voice list itself is not here — it is a vendor call, fetched by the
 * picker when it opens (`voiceClient.status`), never on page load.
 *
 * Null is the whole story when voice is not configured: the thread renders
 * no speaker, no microphone, no menu, and nothing about voice is ever
 * mentioned to the person.
 */

import { getVoicePrefs, type VoicePrefs } from '@renkei/user-prefs';
import { resolveVoiceConfig } from './config';

export interface VoiceAvailability {
  /** The org's defaults, for the picker to say what "Default" means. */
  defaultVoice: string;
  defaultLocale: string;
  prefs: VoicePrefs;
}

export async function loadVoiceAvailability(
  tenantId: string,
  subject: string
): Promise<VoiceAvailability | null> {
  const config = await resolveVoiceConfig(tenantId);
  if (!config) return null;
  const prefs = await getVoicePrefs(tenantId, subject, { fresh: true });
  return { defaultVoice: config.defaultVoice, defaultLocale: config.defaultLocale, prefs };
}
