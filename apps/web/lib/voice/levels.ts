/**
 * A loudness feed, outside React. The microphone and the speaker each
 * report a level dozens of times a second; pushed through component
 * state that would re-render the thread, the composer and everything in
 * them at that rate. Instead the things that draw a level — the wave, the
 * bars — subscribe to a source and move their own pixels, and nothing
 * else on the page is touched.
 *
 * `SpeechQueue` is a source already (its analyser); this is the shape it
 * shares with the microphone, and a small emitter for a recorder to feed.
 */

export interface LevelSource {
  /** Called with 0–1, as often as there is a new reading; returns the unsubscribe. */
  subscribeLevel(listener: (level: number) => void): () => void;
}

export class LevelEmitter implements LevelSource {
  private listeners = new Set<(level: number) => void>();

  subscribeLevel(listener: (level: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(level: number): void {
    for (const listener of this.listeners) listener(level);
  }
}
