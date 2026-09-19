/**
 * The device's audio session, on the one platform that lets a page set
 * it. iOS puts a page that opens the microphone into its telephony mode,
 * and a Bluetooth headset follows: it drops to the hands-free profile —
 * mono, narrow, the assistant's voice through a tin can — and stays there
 * as long as the page looks like a call. `navigator.audioSession` (Safari
 * 17+) is the way to say what the page is doing instead: `playback` while
 * only the assistant sounds, `play-and-record` only while the microphone
 * is actually open. Elsewhere the property does not exist and this does
 * nothing.
 *
 * A count, not a flag: dictation and voice mode each open a microphone,
 * and the session is a call only while at least one is open.
 */

type AudioSessionType =
  'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';

let microphones = 0;

function setType(type: AudioSessionType): void {
  if (typeof navigator === 'undefined') return;
  const session: unknown = Reflect.get(navigator, 'audioSession');
  if (typeof session !== 'object' || session === null) return;
  try {
    Reflect.set(session, 'type', type);
  } catch {
    // A platform that names the session but not this type: left as it was.
  }
}

/** Playback only: the assistant sounds, nobody is being recorded. */
export function playbackSession(): void {
  if (microphones === 0) setType('playback');
}

/**
 * The microphone is opening. Returns the release, to call when its tracks
 * are stopped; the session returns to playback with the last one.
 */
export function recordingSession(): () => void {
  microphones += 1;
  setType('play-and-record');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    microphones -= 1;
    if (microphones === 0) setType('playback');
  };
}
