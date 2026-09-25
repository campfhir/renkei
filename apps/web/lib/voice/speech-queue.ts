/**
 * Plays pieces of a reply in order, as they are handed over, as one
 * continuous voice. Each piece is synthesised through the speech route
 * and decoded the moment it arrives; pieces are then placed back to back
 * on the audio clock — the next scheduled before the current has ended,
 * with a short fade at each cut and the vendor's padding trimmed to a
 * natural sentence break (gapless.ts) — so the sound never stops between
 * sentences. Only a piece the vendor has not yet delivered leaves a gap.
 *
 * A piece with nothing ahead of it — the first of a reply, or the first
 * after a tool call's silence — is the one the person is waiting on, so
 * it is not waited for whole: it is asked for as raw samples
 * (`format: 'pcm'`, PCM_SAMPLE_RATE) and each segment goes on the clock
 * as it arrives, right behind the last (pcm-stream.ts). The context runs
 * at that rate so the segments need no resampling and join without a
 * seam. A piece behind another is fetched whole as MP3 (an eighth of the
 * bytes) while the one before it plays, which is early enough.
 *
 * Playback is Web Audio throughout: decoded buffers through one gain and
 * one analyser (the level behind the wave) to the output. One `<audio>`
 * element plays a loop of silence alongside for as long as a stream is
 * open, or a holder (voice mode) asks: it is the element that owns the
 * device's media session — the indicator in the status bar, the
 * Bluetooth link a headset drops the moment nothing plays, the audio
 * route on a phone — and with it looping the session never closes and
 * reopens in the vendor's latency on the next sentence. Browsers only let
 * a page start sound after a click; `prime()` is called from the click
 * that turns voice on (the toggle, the Listen button, entering voice
 * mode) and plays that element once, so later plays that follow a
 * network reply are allowed.
 *
 * `pause()` holds the clock — everything scheduled stays scheduled — and
 * `resume()` lets it run on from the same sample. `stop()` is immediate
 * and total: the current sound stops, queued pieces are dropped, in-flight
 * fetches are abandoned, because the person pressing it, or talking over
 * it, wants silence now.
 */

import { PCM_SAMPLE_RATE } from '@renkei/voice';
import { playbackSession } from './audio-session';
import { voiceClient, type SpeechRequest, type SpeechStream } from './client';
import { FADE_S, nextStart, soundBounds, soundEnd, soundStart, type SoundBounds } from './gapless';
import { PcmSegmenter } from './pcm-stream';
import { speakableText } from './speech-text';
import { encodeWav } from './wav';

export type SpeechQueueState = 'idle' | 'loading' | 'speaking' | 'paused';

type Settings = Omit<SpeechRequest, 'text'>;

/** A piece fetched whole, decoded and cut to its sound. */
interface DecodedPiece {
  kind: 'whole';
  buffer: AudioBuffer;
  bounds: SoundBounds;
}

/** A piece arriving: the vendor has begun answering, the samples follow. */
interface StreamedPiece {
  kind: 'streamed';
  stream: SpeechStream;
}

type Piece = DecodedPiece | StreamedPiece;

interface QueuedPiece {
  text: string;
  audio: Promise<Piece | null>;
  controller: AbortController;
}

interface Playing {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

/** How far ahead of the clock a piece is placed when it starts now. */
const SCHEDULE_LEAD_S = 0.03;
/**
 * A streamed piece's samples go on the clock in segments at least this
 * long: short enough that the first sounds as soon as the vendor's first
 * chunk lands, long enough not to make a source node of every packet.
 */
const STREAM_SEGMENT_S = 0.1;

export class SpeechQueue {
  private queue: QueuedPiece[] = [];
  private playing = new Set<Playing>();
  private pumping = false;
  private finished = true;
  private paused = false;
  private generation = 0;
  private listeners = new Set<(state: SpeechQueueState) => void>();
  private lastState: SpeechQueueState = 'idle';
  private settings: Settings = { voice: null, rate: 1, locale: null };
  /** Which stream of text is playing — a Listen button, or the live reply. */
  public owner: string | null = null;
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array<ArrayBuffer> | null = null;
  /** The clock time the last scheduled piece ends. */
  private lastEnd = 0;
  private levelListeners = new Set<(level: number) => void>();
  private levelFrame = 0;
  // The session holder: a loop of silence, playing while a stream is
  // open or voice mode asks.
  private session: HTMLAudioElement | null = null;
  private sessionUrl: string | null = null;
  private holders = 0;
  private sinkId: string | null = null;

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
    this.updateSession();
    for (const listener of this.listeners) listener(state);
  }

  /**
   * The state as the facts make it: paused holds; sound scheduled is
   * speaking; pieces on the way are loading; nothing left and the stream
   * closed is idle. Nothing left but the stream still open (a reply
   * still being written) keeps whatever it was, so the wave does not
   * flicker to idle between one sentence and the next.
   */
  private refreshState(): void {
    if (this.paused) return this.setState('paused');
    if (this.playing.size > 0) return this.setState('speaking');
    if (this.queue.length > 0) return this.setState('loading');
    if (this.finished) return this.setState('idle');
  }

  /* ---------------------------------------------------------------- output */

  /**
   * The context, made on demand; it runs from prime(), which a click
   * calls. Made at the vendor's sample rate, so a streamed piece's raw
   * samples play as they are and a decoded MP3 (the same rate) needs no
   * resampling either; a device that refuses the rate gets the default,
   * and every piece is then fetched whole.
   */
  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    if (typeof AudioContext === 'undefined') return null;
    try {
      let context: AudioContext;
      try {
        context = new AudioContext({ sampleRate: PCM_SAMPLE_RATE });
      } catch {
        context = new AudioContext();
      }
      const master = context.createGain();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.6;
      master.connect(analyser);
      analyser.connect(context.destination);
      this.context = context;
      this.master = master;
      this.analyser = analyser;
      this.samples = new Float32Array(analyser.fftSize);
      if (this.sinkId !== null) this.applySink(context);
      return context;
    } catch {
      return null;
    }
  }

  private ensureSession(): HTMLAudioElement {
    if (this.session) return this.session;
    const element = new Audio();
    element.loop = true;
    element.preload = 'auto';
    // A quarter second of silence, looped; made here rather than shipped
    // so there is nothing to fetch.
    this.sessionUrl = URL.createObjectURL(
      new Blob([encodeWav(new Float32Array(4_000))], { type: 'audio/wav' })
    );
    element.src = this.sessionUrl;
    if (this.sinkId !== null) void this.applySinkToElement(element);
    this.session = element;
    return element;
  }

  /** The silence loop plays while wanted; a play refused outside a gesture is retried by the next prime. */
  private updateSession(): void {
    const wanted = this.holders > 0 || (this.lastState !== 'idle' && this.lastState !== 'paused');
    const element = this.ensureSession();
    if (wanted) {
      if (element.paused) void element.play().catch(() => undefined);
    } else if (!element.paused) {
      element.pause();
    }
  }

  /**
   * Keep the session open while nothing plays. Returns the release.
   * Voice mode holds for as long as it is open, so the first sentence of
   * a reply lands on a headset that is already awake; the queue holds on
   * its own from `begin()` to idle.
   */
  hold(): () => void {
    this.holders += 1;
    this.updateSession();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders -= 1;
      this.updateSession();
    };
  }

  /**
   * Play through this output device (an `audiooutput` id from
   * enumerateDevices), or the default with null. Where the browser cannot
   * choose (Safari), the request is kept for a context that can and the
   * default is used.
   */
  setOutputDevice(deviceId: string | null): void {
    this.sinkId = deviceId;
    if (this.context) this.applySink(this.context);
    if (this.session) void this.applySinkToElement(this.session);
  }

  private applySink(context: AudioContext): void {
    const sink: unknown = Reflect.get(context, 'setSinkId');
    if (typeof sink !== 'function') return;
    const result: unknown = Reflect.apply(sink, context, [this.sinkId ?? '']);
    if (result instanceof Promise) {
      result.catch(() => {
        // The device is gone, or refused: the default plays instead.
      });
    }
  }

  private async applySinkToElement(element: HTMLAudioElement): Promise<void> {
    const sink: unknown = Reflect.get(element, 'setSinkId');
    if (typeof sink !== 'function') return;
    try {
      await Reflect.apply(sink, element, [this.sinkId ?? '']);
    } catch {
      // As above.
    }
  }

  /** Whether this browser can route playback to a chosen output device. */
  static canChooseOutput(): boolean {
    return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  }

  /** From a click: takes the browser's permission to play sound later. */
  prime(): void {
    playbackSession();
    const context = this.ensureContext();
    void context?.resume().catch(() => undefined);
    // Played once from the gesture, then left as the state wants it.
    const element = this.ensureSession();
    void element.play().catch(() => {
      // Denied outside a gesture; nothing to do but try again later.
    });
    this.updateSession();
  }

  /* ---------------------------------------------------------------- levels */

  /** The speaker's loudness, 0–1, as often as the screen repaints while playing. */
  subscribeLevel(listener: (level: number) => void): () => void {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  private startLevelLoop(): void {
    if (this.levelFrame || !this.analyser || this.levelListeners.size === 0) return;
    const tick = () => {
      if (this.playing.size === 0 || this.paused || !this.analyser || !this.samples) {
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

  /* ---------------------------------------------------------------- stream */

  /** Whether anything is queued, loading or sounding. */
  get busy(): boolean {
    return this.playing.size > 0 || this.queue.length > 0;
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
    // Nothing ahead of it: the person is waiting on this piece, so it
    // plays as it arrives. Anything behind another piece is fetched whole
    // while that one plays.
    const streamed = this.queue.length === 0 && this.playing.size === 0 && this.canStream();
    const audio: Promise<Piece | null> = (
      streamed
        ? voiceClient
            .synthesizeStream(this.tenantId, { text, ...this.settings }, controller.signal)
            .then((result): Piece | null => {
              if (generation !== this.generation) return null;
              if (result.error) this.onError(result.error);
              return result.data ? { kind: 'streamed', stream: result.data } : null;
            })
        : voiceClient
            .synthesize(this.tenantId, { text, ...this.settings }, controller.signal)
            .then(async (result): Promise<Piece | null> => {
              if (generation !== this.generation) return null;
              if (result.error) this.onError(result.error);
              if (!result.data) return null;
              return this.decode(result.data);
            })
    ).catch(() => null);
    this.queue.push({ text, audio, controller });
    this.refreshState();
    void this.pump();
  }

  /** Raw samples can be played as they come only at the rate they come at. */
  private canStream(): boolean {
    if (typeof ReadableStream === 'undefined') return false;
    const context = this.ensureContext();
    return context !== null && context.sampleRate === PCM_SAMPLE_RATE;
  }

  /** The piece as samples, cut to its sound. Decoding needs no gesture. */
  private async decode(blob: Blob): Promise<DecodedPiece | null> {
    const context = this.ensureContext();
    if (!context) {
      this.onError('This browser cannot play speech.');
      return null;
    }
    try {
      const buffer = await context.decodeAudioData(await blob.arrayBuffer());
      return {
        kind: 'whole',
        buffer,
        bounds: soundBounds(buffer.getChannelData(0), buffer.sampleRate),
      };
    } catch {
      this.onError('The audio could not be decoded.');
      return null;
    }
  }

  /** No more pieces are coming for this stream; idle follows the last one. */
  finish(): void {
    this.finished = true;
    this.refreshState();
  }

  /** Hold the clock where it is; resume() carries on from the same sample. */
  pause(): void {
    if (this.paused || (this.lastState !== 'speaking' && this.lastState !== 'loading')) return;
    this.paused = true;
    void this.context?.suspend().catch(() => undefined);
    this.refreshState();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    void this.context?.resume().catch(() => undefined);
    this.refreshState();
    this.startLevelLoop();
  }

  /** Silence, now. */
  stop(): void {
    this.generation += 1;
    for (const piece of this.queue) piece.controller.abort();
    this.queue = [];
    this.finished = true;
    for (const entry of this.playing) {
      try {
        entry.source.stop();
      } catch {
        // Not started yet, or already over.
      }
      entry.source.disconnect();
      entry.gain.disconnect();
    }
    this.playing.clear();
    this.lastEnd = 0;
    if (this.paused) {
      this.paused = false;
      void this.context?.resume().catch(() => undefined);
    }
    this.owner = null;
    this.setState('idle');
  }

  /**
   * Places each piece on the clock as soon as it is decoded, in order.
   * Runs ahead of playback: the next piece is scheduled while the current
   * one sounds, which is what makes the join seamless.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const generation = this.generation;
        const next = this.queue[0];
        const piece = await next.audio;
        if (generation !== this.generation) return;
        if (piece?.kind === 'streamed') {
          // Kept at the head of the queue while it arrives: a piece
          // enqueued meanwhile sees something ahead of it and is fetched
          // whole, and the state never reads as nothing left.
          await this.scheduleStreamed(piece.stream, generation);
          if (generation !== this.generation) return;
        } else if (piece) {
          this.schedule(piece);
        }
        this.queue.shift();
        this.refreshState();
      }
    } finally {
      this.pumping = false;
    }
  }

  private schedule(piece: DecodedPiece): void {
    const context = this.ensureContext();
    if (!context || !this.master) return;
    void context.resume().catch(() => undefined);
    const { buffer, bounds } = piece;
    const start = nextStart(this.lastEnd, context.currentTime, SCHEDULE_LEAD_S);
    const end = start + bounds.duration;
    const gain = context.createGain();
    const fade = Math.min(FADE_S, bounds.duration / 2);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(1, start + fade);
    gain.gain.setValueAtTime(1, end - fade);
    gain.gain.linearRampToValueAtTime(0, end);
    gain.connect(this.master);
    this.place(context, buffer, bounds, start, gain);
    this.lastEnd = end;
  }

  /**
   * A streamed piece: each segment of samples goes on the clock as it
   * lands, right behind the one before, under one gain that fades in at
   * the piece's first sound and out at its last. Silent segments before
   * the first sound are the vendor's padding, not played; the padding
   * after the last is cut once the stream ends, where the next piece
   * then follows (as gapless.ts does for a whole piece). A segment that
   * arrives after its slot has passed — the network fell behind the
   * voice — starts as soon as it can, the one gap streaming allows.
   * Resolves when everything has been placed; a stop mid-way ends it.
   */
  private async scheduleStreamed(stream: SpeechStream, generation: number): Promise<void> {
    const context = this.ensureContext();
    const reader = stream.getReader();
    if (!context || !this.master) {
      this.onError('This browser cannot play speech.');
      await reader.cancel().catch(() => undefined);
      return;
    }
    void context.resume().catch(() => undefined);
    const segmenter = new PcmSegmenter(Math.round(STREAM_SEGMENT_S * PCM_SAMPLE_RATE));
    const gain = context.createGain();
    gain.connect(this.master);
    // Where the next segment goes, once the piece has started; and the
    // last segment placed, whose padding is cut when the stream ends.
    let at: number | null = null;
    const tail: {
      last: { samples: Float32Array<ArrayBuffer>; start: number; entry: Playing } | null;
    } = { last: null };
    const place = (samples: Float32Array<ArrayBuffer>) => {
      let offset = 0;
      if (at === null) {
        const first = soundStart(samples, PCM_SAMPLE_RATE);
        if (first === null) return;
        offset = first;
        at = nextStart(this.lastEnd, context.currentTime, SCHEDULE_LEAD_S);
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(1, at + FADE_S);
      }
      const duration = samples.length / PCM_SAMPLE_RATE - offset;
      if (duration <= 0) return;
      const start = Math.max(at, context.currentTime + SCHEDULE_LEAD_S);
      const buffer = context.createBuffer(1, samples.length, PCM_SAMPLE_RATE);
      buffer.copyToChannel(samples, 0);
      const entry = this.place(context, buffer, { offset, duration }, start, gain);
      at = start + duration;
      this.lastEnd = at;
      tail.last = { samples, start, entry };
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (generation !== this.generation) return;
        const segment = done ? segmenter.flush() : value ? segmenter.push(value) : null;
        if (segment) place(segment);
        if (done) break;
      }
    } catch {
      // Aborted by stop(), or the connection dropped: what was placed
      // plays out, and the next piece follows it.
    } finally {
      reader.releaseLock();
    }
    const placed = tail.last;
    if (generation !== this.generation || at === null || placed === null) return;
    // The end of the piece is the end of its sound, not of the vendor's
    // trailing silence: the last source stops there, and so the next piece
    // starts there.
    const { samples, start, entry } = placed;
    const soundsUntil = soundEnd(samples, PCM_SAMPLE_RATE);
    const end = soundsUntil === null ? at : Math.min(at, start + soundsUntil);
    if (end < at) {
      try {
        entry.source.stop(end);
      } catch {
        // Already over.
      }
    }
    this.lastEnd = end;
    gain.gain.setValueAtTime(1, Math.max(context.currentTime, end - FADE_S));
    gain.gain.linearRampToValueAtTime(0, end);
  }

  /** One buffer on the clock through `gain`, tracked until it ends. */
  private place(
    context: AudioContext,
    buffer: AudioBuffer,
    bounds: SoundBounds,
    start: number,
    gain: GainNode
  ): Playing {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const entry: Playing = { source, gain };
    const generation = this.generation;
    source.onended = () => {
      if (generation !== this.generation) return;
      source.disconnect();
      this.playing.delete(entry);
      if (![...this.playing].some((other) => other.gain === gain)) gain.disconnect();
      this.refreshState();
    };
    source.start(start, bounds.offset, bounds.duration);
    this.playing.add(entry);
    this.refreshState();
    this.startLevelLoop();
    return entry;
  }

  /** Release everything; for unmount. */
  dispose(): void {
    this.stop();
    this.holders = 0;
    this.updateSession();
    this.listeners.clear();
    this.levelListeners.clear();
    if (this.levelFrame) cancelAnimationFrame(this.levelFrame);
    this.levelFrame = 0;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.master = null;
    this.analyser = null;
    if (this.session) {
      this.session.pause();
      this.session.removeAttribute('src');
      this.session.load();
      this.session = null;
    }
    if (this.sessionUrl) {
      URL.revokeObjectURL(this.sessionUrl);
      this.sessionUrl = null;
    }
  }
}
