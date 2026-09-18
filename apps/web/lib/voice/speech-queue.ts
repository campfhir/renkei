/**
 * Plays pieces of a reply in order, as they are handed over. Each piece
 * is synthesised through the speech route; the next piece's audio is
 * fetched while the current one plays, so the gaps between sentences are
 * the vendor's latency hidden behind playback, not added to it.
 *
 * One `<audio>` element, reused. Browsers only let a page start sound
 * after a click or a key press; `prime()` is called from the click that
 * turns voice on (the toggle, the Listen button, entering voice mode) so
 * later plays that follow a network reply are allowed.
 *
 * `stop()` is immediate and total — the current sound stops, queued pieces
 * are dropped, in-flight fetches are abandoned — because the person
 * pressing it, or talking over it, wants silence now.
 */

import { voiceClient, type SpeechRequest } from './client';
import { speakableText } from './speech-text';

export type SpeechQueueState = 'idle' | 'loading' | 'speaking';

type Settings = Omit<SpeechRequest, 'text'>;

interface QueuedPiece {
  text: string;
  audio: Promise<Blob | null>;
  controller: AbortController;
}

export class SpeechQueue {
  private queue: QueuedPiece[] = [];
  private audio: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  private playing = false;
  private finished = false;
  private generation = 0;
  private listeners = new Set<(state: SpeechQueueState) => void>();
  private lastState: SpeechQueueState = 'idle';
  private settings: Settings = { voice: null, rate: 1, locale: null };
  private inFlight = 0;
  /** Which stream of text is playing — a Listen button, or the live reply. */
  public owner: string | null = null;

  constructor(
    private readonly tenantId: string,
    private readonly onError: (message: string) => void
  ) {}

  configure(settings: Settings): void {
    this.settings = settings;
  }

  get state(): SpeechQueueState {
    return this.lastState;
  }

  subscribe(listener: (state: SpeechQueueState) => void): () => void {
    this.listeners.add(listener);
    listener(this.lastState);
    return () => this.listeners.delete(listener);
  }

  private setState(state: SpeechQueueState): void {
    if (state === this.lastState) return;
    this.lastState = state;
    for (const listener of this.listeners) listener(state);
  }

  private ensureAudio(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
    }
    return this.audio;
  }

  /** From a click: takes the browser's permission to play sound later. */
  prime(): void {
    const audio = this.ensureAudio();
    if (audio.src) return;
    // A tiny silent WAV: one sample. Playing it unlocks the element.
    audio.src =
      'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQIAAAAAAA==';
    void audio.play().catch(() => {
      // Denied outside a gesture; nothing to do but try again later.
    });
  }

  /** Whether anything is queued, loading or sounding. */
  get busy(): boolean {
    return this.playing || this.queue.length > 0;
  }

  /** Begin a fresh stream of pieces under `owner`, silencing whatever was playing. */
  begin(owner: string): void {
    this.stop();
    this.owner = owner;
    this.finished = false;
  }

  /** Add a piece of Markdown to say; nothing is said for markup-only text. */
  enqueue(markdown: string): void {
    const text = speakableText(markdown);
    if (!text) return;
    const controller = new AbortController();
    const generation = this.generation;
    this.inFlight += 1;
    if (!this.playing) this.setState('loading');
    const audio = voiceClient
      .synthesize(this.tenantId, { text, ...this.settings }, controller.signal)
      .then((result) => {
        if (generation !== this.generation) return null;
        if (result.error) this.onError(result.error);
        return result.data;
      })
      .finally(() => {
        this.inFlight -= 1;
      });
    this.queue.push({ text, audio, controller });
    void this.pump();
  }

  /** No more pieces are coming for this stream; idle follows the last one. */
  finish(): void {
    this.finished = true;
    if (!this.playing && this.queue.length === 0) {
      this.owner = null;
      this.setState('idle');
    }
  }

  /** Silence, now. */
  stop(): void {
    this.generation += 1;
    for (const piece of this.queue) piece.controller.abort();
    this.queue = [];
    this.finished = true;
    this.playing = false;
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    this.owner = null;
    this.setState('idle');
  }

  private async pump(): Promise<void> {
    if (this.playing) return;
    const next = this.queue.shift();
    if (!next) {
      if (this.finished) {
        this.owner = null;
        this.setState('idle');
      }
      return;
    }
    this.playing = true;
    const generation = this.generation;
    const blob = await next.audio;
    if (generation !== this.generation) return;
    if (!blob) {
      this.playing = false;
      void this.pump();
      return;
    }
    const audio = this.ensureAudio();
    if (this.currentUrl) URL.revokeObjectURL(this.currentUrl);
    this.currentUrl = URL.createObjectURL(blob);
    audio.src = this.currentUrl;
    this.setState('speaking');
    const done = new Promise<void>((resolve) => {
      const finish = () => {
        audio.removeEventListener('ended', finish);
        audio.removeEventListener('error', finish);
        resolve();
      };
      audio.addEventListener('ended', finish);
      audio.addEventListener('error', finish);
    });
    try {
      await audio.play();
      await done;
    } catch {
      // A stop() mid-play rejects play() too; only a real refusal is news.
      if (generation !== this.generation) return;
      this.onError('The browser would not play the audio. Click the speaker to allow sound.');
    }
    if (generation !== this.generation) return;
    this.playing = false;
    if (this.queue.length > 0) this.setState('loading');
    void this.pump();
  }

  /** Release the element; for unmount. */
  dispose(): void {
    this.stop();
    this.listeners.clear();
    this.audio = null;
  }
}
