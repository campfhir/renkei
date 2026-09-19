/**
 * Voice settings that belong to THIS device, not to the person: kept in
 * the browser's localStorage, like the desktop-notification opt-in
 * (lib/desktop-notifications-storage.ts), because the right answer
 * differs from one machine and headset to the next and a value saved from
 * a laptop would be wrong on a phone.
 *
 * Echo cancellation — and with it the browser's other voice processing,
 * noise suppression and automatic gain, since each alone puts a
 * Bluetooth headset on its hands-free profile — is one. On by default — it is what lets a
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

/*
  Which microphone and which speaker, when the browser lets a page choose
  (enumerateDevices ids; the output side needs AudioContext.setSinkId,
  which Safari lacks). Null is the system default. An id that no longer
  exists — the headset is off — is simply the default again where it is
  used, never an error.
*/

const microphoneKey = (tenantId: string) => `renkei:${tenantId}:voice:microphone`;
const outputKey = (tenantId: string) => `renkei:${tenantId}:voice:output`;

function readDevice(key: string): string | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(key) || null;
  } catch {
    return null;
  }
}

function writeDevice(key: string, deviceId: string | null): void {
  try {
    if (deviceId) window.localStorage.setItem(key, deviceId);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage blocked: the choice lasts the session.
  }
}

export function getMicrophone(tenantId: string): string | null {
  return readDevice(microphoneKey(tenantId));
}

export function setMicrophone(tenantId: string, deviceId: string | null): void {
  writeDevice(microphoneKey(tenantId), deviceId);
}

export function getAudioOutput(tenantId: string): string | null {
  return readDevice(outputKey(tenantId));
}

export function setAudioOutput(tenantId: string, deviceId: string | null): void {
  writeDevice(outputKey(tenantId), deviceId);
}

export interface AudioDevice {
  id: string;
  label: string;
}

/**
 * The microphones and speakers the browser will name. Names come only
 * once a microphone has been allowed (before that every device is a
 * blank), so the list is asked for when a menu opens and again after
 * the microphone has been used.
 */
export async function listAudioDevices(): Promise<{
  microphones: AudioDevice[];
  outputs: AudioDevice[];
}> {
  const empty = { microphones: [], outputs: [] };
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return empty;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const named = (kind: MediaDeviceKind, fallback: string): AudioDevice[] =>
      devices
        .filter(
          (device) => device.kind === kind && device.deviceId && device.deviceId !== 'default'
        )
        .map((device, index) => ({
          id: device.deviceId,
          label: device.label || `${fallback} ${index + 1}`,
        }));
    return {
      microphones: named('audioinput', 'Microphone'),
      outputs: named('audiooutput', 'Speaker'),
    };
  } catch {
    return empty;
  }
}
