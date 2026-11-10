/**
 * The composer's speaker menu (voice-menu.tsx), with no DOM or audio:
 * what the speaker button says, the speeds on offer, which device
 * choosers show and what they list, and whether the Hear button is
 * playing. Choosing a language or a voice is voice-picker.model.ts's,
 * shared with Preferences. Every change is saved at once by the chat
 * around it, so there is no form state here. Tested in
 * voice-menu.model.test.ts.
 */

import type { AudioDevice } from '@/lib/voice/device-settings';
import type { SpeechQueueState } from '@/lib/voice/speech-queue';

export const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

/** The speaker button's title: reading now, reading every reply, or just the menu. */
export function speakerTitle(queueState: SpeechQueueState, autoPlay: boolean): string {
  if (queueState !== 'idle') return 'Reading the reply aloud';
  return autoPlay ? 'Replies are read aloud' : 'Voice';
}

/**
 * A device list as its chooser offers it. A chosen device that is not
 * listed now stays listed, so the choice is visible and can be dropped;
 * it is the default until it is back.
 */
export function deviceOptions(list: AudioDevice[], chosen: string | null): AudioDevice[] {
  return chosen && !list.some((device) => device.id === chosen)
    ? [...list, { id: chosen, label: 'Chosen device (not connected)' }]
    : list;
}

/** Which device choosers show, once the devices have been listed. */
export function deviceChoosers(input: {
  devices: { microphones: AudioDevice[]; outputs: AudioDevice[] } | null;
  microphone: string | null;
  audioOutput: string | null;
  canChooseOutput: boolean;
}): { microphone: boolean; output: boolean; unnamed: boolean } {
  const { devices } = input;
  if (!devices) return { microphone: false, output: false, unnamed: false };
  return {
    microphone: devices.microphones.length > 0 || Boolean(input.microphone),
    output: input.canChooseOutput && (devices.outputs.length > 0 || Boolean(input.audioOutput)),
    // Browsers name devices only once the microphone has been allowed.
    unnamed: devices.microphones.length === 0 && devices.outputs.length === 0,
  };
}

/** The chosen voice's sample is playing (the default voice's key is ''). */
export function hearingChosen(previewing: string | null, voice: string | null): boolean {
  return previewing === (voice ?? '');
}
