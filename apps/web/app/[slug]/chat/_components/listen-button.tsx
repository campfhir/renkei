'use client';

/**
 * "Listen" beside "Copy" under a reply: reads that one reply aloud. While
 * it does, the button becomes "Pause" and a "Stop" appears to its right;
 * paused, it becomes "Resume" and Stop stays. Present only when the org
 * has a voice service; the thread owns the queue and says which reply is
 * playing and whether it is held.
 */

import { Icon, ICONS } from '@/components/icons';

const CLASS =
  'flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-900 dark:hover:text-gray-200';

export default function ListenButton({
  state,
  onListen,
  onPause,
  onResume,
  onStop,
}: {
  /** This reply's playback: not playing, sounding, or held. */
  state: 'idle' | 'playing' | 'paused';
  onListen: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  if (state === 'idle') {
    return (
      <button type="button" onClick={onListen} className={CLASS}>
        <Icon path={ICONS.speaker} className="h-3.5 w-3.5" />
        Listen
      </button>
    );
  }
  return (
    <>
      {state === 'playing' ? (
        <button type="button" onClick={onPause} className={CLASS}>
          <Icon path={ICONS.pause} className="h-3.5 w-3.5" />
          Pause
        </button>
      ) : (
        <button type="button" onClick={onResume} className={CLASS}>
          <Icon path={ICONS.play} className="h-3.5 w-3.5" />
          Resume
        </button>
      )}
      <button type="button" onClick={onStop} className={CLASS}>
        <Icon path={ICONS.stop} className="h-3.5 w-3.5" />
        Stop
      </button>
    </>
  );
}
