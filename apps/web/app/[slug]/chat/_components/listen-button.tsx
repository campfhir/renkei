'use client';

/**
 * "Listen" beside "Copy" under a reply: reads that one reply aloud, and
 * turns into "Stop" while it does. Present only when the org has a voice
 * service; the thread owns the queue and says which reply is playing.
 */

import { Icon, ICONS } from '@/components/icons';

export default function ListenButton({
  playing,
  onListen,
  onStop,
}: {
  playing: boolean;
  onListen: () => void;
  onStop: () => void;
}) {
  return (
    <button
      type="button"
      onClick={playing ? onStop : onListen}
      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-gray-900 dark:hover:text-gray-200"
    >
      <Icon path={playing ? ICONS.stop : ICONS.speaker} className="h-3.5 w-3.5" />
      {playing ? 'Stop' : 'Listen'}
    </button>
  );
}
