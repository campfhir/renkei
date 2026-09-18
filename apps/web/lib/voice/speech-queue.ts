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
  // The speaker's loudness, for the wave: an analyser tapped into the
  // element's output, read once a frame while something plays.
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  private levelListeners = new Set<(level: number) => void>();
  private levelFrame = 0;

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

  /**
   * Route the element through an analyser so its loudness can be read.
   * Done from a click (prime) because an AudioContext made elsewhere
   * starts suspended; once routed, the context is what plays the sound.
   */
  private ensureAnalyser(): void {
    if (this.analyser || typeof AudioContext === 'undefined') return;
    try {
      const audio = this.ensureAudio();
      const context = new AudioContext();
      const source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      analyser.connect(context.destination);
      this.audioContext = context;
      this.analyser = analyser;
      this.samples = new Float32Array(analyser.fftSize);
    } catch {
      // No analyser: the wave idles instead of following the sound.
    }
  }

  /** The speaker's loudness, 0–1, as often as the screen repaints while playing. */
  subscribeLevel(listener: (level: number) => void): () => void {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  private startLevelLoop(): void {
    if (this.levelFrame || !this.analyser || this.levelListeners.size === 0) return;
    const tick = () => {
      if (!this.playing || !this.analyser || !this.samples) {
        this.levelFrame = 0;
        for (const listener of this.levelListeners) listener(0);
        return;
      }
      this.analyser.getFloatTimeDomainData(this.samples);
      let sum = 0;
      for (let index = 0; index < this.samples.length; index += 1) {
        sum += this.samples[index] * this.samples[index];
      }
      const level = Math.min(1, Math.sqrt(sum / this.samples.length) * 4);
      for (const listener of this.levelListeners) listener(level);
      this.levelFrame = requestAnimationFrame(tick);
    };
    this.levelFrame = requestAnimationFrame(tick);
  }

  /** From a click: takes the browser's permission to play sound later. */
  prime(): void {
    const audio = this.ensureAudio();
    this.ensureAnalyser();
    void this.audioContext?.resume().catch(() => undefined);
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
      void this.audioContext?.resume().catch(() => undefined);
      await audio.play();
      this.startLevelLoop();
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
    this.levelListeners.clear();
    if (this.levelFrame) cancelAnimationFrame(this.levelFrame);
    this.levelFrame = 0;
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.analyser = null;
    this.audio = null;
  }
}
