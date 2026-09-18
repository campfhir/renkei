/**
 * Voice settings that belong to THIS device, not to the person: kept in
 * the browser's localStorage, like the desktop-notification opt-in
 * (lib/desktop-notifications-storage.ts), because the right answer
 * differs from one machine and headset to the next and a value saved from
 * a laptop would be wrong on a phone.
 *
 * Echo cancellation is the one so far. On by default — it is what lets a
 * person talk over the assistant without the assistant's own voice, heard
 * through the microphone, counting as an interruption. But asking the
 * browser for it makes some platforms route sound through a voice-call
 * path (macOS voice processing, a Bluetooth headset's hands-free profile),
 * and there the assistant can come out of one speaker only, muffled, or
 * with artefacts, the moment the microphone opens. Off, playback is left
 * alone and the reply is interrupted with Stop instead of a voice.
 */

const storageKey = (tenantId: string) => `renkei:${tenantId}:voice:echo-cancellation`;

export function getEchoCancellation(tenantId: string): boolean {
  try {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(storageKey(tenantId)) !== '0';
  } catch {
    return true;
  }
}

export function setEchoCancellation(tenantId: string, enabled: boolean): void {
  try {
    window.localStorage.setItem(storageKey(tenantId), enabled ? '1' : '0');
  } catch {
    // Storage blocked (private window, quota): the choice lasts the session.
  }
}
