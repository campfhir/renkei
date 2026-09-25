/**
 * The microphone, cut into utterances. Voice mode does not stream audio to
 * the vendor; it listens locally for the person to start and stop
 * speaking, then sends that one stretch of sound to be recognised whole.
 * Speech is detected by loudness against a noise floor that adapts to the
 * room: a few frames above it start an utterance, a pause below it ends
 * one, and a little of what came just before the start is kept so the
 * first syllable is not clipped.
 *
 * `onSpeechStart` fires the moment speech is detected — before the
 * utterance is complete. `onSpeechHeld` fires once the utterance has
 * carried a few words' worth of sound (HELD_FRAMES), with that sound so
 * far encoded as WAV: loudness alone cannot tell a cough or a "mm-hm"
 * from a person actually talking, so voice mode has the snippet
 * transcribed and interrupts a reply mid-sentence only when the
 * recognizer heard words (lib/voice/barge-in.ts). The utterance itself
 * is sent when it closes.
 *
 * In `manual` mode (the walkie-talkie preference) the detector decides
 * nothing: `beginTake()` opens an utterance and `endTake()` closes it, so
 * a pause to think is never mistaken for the end of a sentence. The only
 * things that close a take unasked are a long silence — ten seconds with
 * nothing said, the person having walked away or forgotten the button —
 * and the length cap the transcription route accepts.
 *
 * Echo cancellation is asked of the browser so the assistant's own voice
 * from the speakers is not heard as the person talking; on a device that
 * cannot cancel it, `holdWhileSpeaking` raises the bar while the assistant
 * speaks instead. Off, the browser's other voice processing (noise
 * suppression, automatic gain) is off with it: each of the three is what
 * makes an operating system treat the stream as a call and move a
 * Bluetooth headset to its hands-free profile, and a person who turned
 * it off did so because of that.
 *
 * While the microphone is open the device's audio session is a recording
 * one (audio-session.ts); it is closed the moment the recorder stops.
 */

import { recordingSession } from './audio-session';
import { concat, encodeWav, resample, rms, TARGET_SAMPLE_RATE } from './wav';

export interface RecorderOptions {
  /**
   * Ask the browser to cancel the speakers' echo from the microphone, and
   * to suppress noise and level the gain. Default true; off where the
   * platform's voice-call path degrades playback while the microphone is
   * open (lib/voice/device-settings.ts), and then all three are off.
   */
  echoCancellation?: boolean;
  /** An `audioinput` device id from enumerateDevices; null or unknown is the default. */
  deviceId?: string | null;
  /**
   * `auto` (default): an utterance starts and ends by loudness. `manual`:
   * it starts with `beginTake()` and ends with `endTake()`.
   */
  mode?: RecorderMode;
  onSpeechStart: () => void;
  /**
   * The open utterance has carried enough sound to be worth judging
   * (HELD_FRAMES of loud frames): here it is so far, as 16 kHz mono WAV,
   * for the recognizer to say whether it is words. Once per utterance,
   * in auto mode only: a manual take is words by definition — a button
   * was pressed for it — and interrupts on `beginTake()` instead.
   */
  onSpeechHeld?: (wav: ArrayBuffer) => void;
  onUtterance: (wav: ArrayBuffer, durationMs: number) => void;
  /**
   * The utterance closed, however it closed — sent, or too short to be
   * worth sending; in manual mode, by the button, by silence, or by the
   * cap. What a Talk button needs to show itself released.
   */
  onSpeechEnd?: (reason: SpeechEndReason) => void;
  /** Loudness, 0–1, for a level meter; called often. */
  onLevel?: (level: number) => void;
  onError: (message: string) => void;
}

export type RecorderMode = 'auto' | 'manual';
export type SpeechEndReason = 'pause' | 'ended' | 'silence' | 'length';

/** Frames this long are what the detector judges; ~50 ms at 16 kHz. */
const FRAME_SAMPLES = 800;
/** Kept before a detected start, so the first syllable is not lost. */
const PRE_ROLL_FRAMES = 6;
/** Consecutive loud frames that count as speech starting. */
const START_FRAMES = 3;
/**
 * Loud frames in an utterance before its sound so far is handed over to
 * be judged: ~0.8 s. Short enough that talking over a reply still cuts
 * it within a couple of seconds, recognition included; long enough to
 * hold a word or two for the recognizer to find, and for a cough or a
 * chair scraping to have ended already.
 */
const HELD_FRAMES = 16;
/**
 * Quiet frames that close an utterance: ~1.6 s of silence. Long enough
 * that a breath, or a pause to find the next word, is not taken for the
 * end of what the person meant to say; the reply is that much later to
 * start, which is the trade.
 */
const END_FRAMES = 32;
/** In manual mode, this much silence closes the take unasked: ten seconds. */
const SILENCE_FLOOR_FRAMES = 200;
/** Less sound than this in an utterance is a click or a cough, not a sentence. */
const MIN_UTTERANCE_MS = 300;
/** Longer than this is sent as it is, so a monologue still gets an answer. */
const MAX_UTTERANCE_MS = 45_000;
/**
 * A manual take may run longer — the person chose when to stop — up to
 * what the transcription route accepts (2 MiB of 16 kHz mono: ~65 s).
 */
const MAX_TAKE_MS = 60_000;
/** Silence and length are judged per frame; frames are this long. */
const FRAME_MS = (FRAME_SAMPLES * 1000) / TARGET_SAMPLE_RATE;
/** The quietest "loud"; below this a room is silent whatever the floor says. */
const MIN_THRESHOLD = 0.012;

export class UtteranceRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private pending: Float32Array[] = [];
  private pendingLength = 0;
  private preRoll: Float32Array[] = [];
  private utterance: Float32Array[] = [];
  private loudRun = 0;
  private quietRun = 0;
  /** Loud frames in the open utterance: what was actually said, pre-roll and pauses aside. */
  private loudFrames = 0;
  /** `onSpeechHeld` has fired for the open utterance. */
  private held = false;
  private speaking = false;
  private noiseFloor = 0.004;
  private muted = false;
  private holding = false;
  private stopped = true;
  private releaseSession: (() => void) | null = null;
  /** Bumped by start() and stop(), so an open that outlives its stop() is dropped. */
  private opening = 0;
  private readonly manual: boolean;

  constructor(private readonly options: RecorderOptions) {
    this.manual = options.mode === 'manual';
  }

  /** While true, sound is ignored — a mute button, or the mic simply idle. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!muted) return;
    const taking = this.taking;
    this.reset();
    // A take dropped by muting is still over; the button must show it.
    if (taking) this.options.onSpeechEnd?.('ended');
  }

  /**
   * While the assistant speaks, demand more before calling it speech: on
   * a device without echo cancellation its own voice would otherwise
   * interrupt itself.
   */
  holdWhileSpeaking(holding: boolean): void {
    this.holding = holding;
  }

  get active(): boolean {
    return !this.stopped;
  }

  /** In manual mode: an utterance is open, being recorded. */
  get taking(): boolean {
    return this.manual && this.speaking;
  }

  /**
   * Manual mode: open an utterance now. Fires `onSpeechStart` just as a
   * detected start would, so pressing Talk interrupts a reply the same
   * way talking over it does.
   */
  beginTake(): void {
    if (!this.manual || this.speaking) return;
    this.speaking = true;
    this.quietRun = 0;
    this.loudRun = 0;
    this.loudFrames = 0;
    this.held = false;
    this.utterance = [...this.preRoll];
    this.preRoll = [];
    this.options.onSpeechStart();
  }

  /** Manual mode: close the open utterance and send it. */
  endTake(): void {
    if (!this.taking) return;
    this.close(this.durationMs(), 'ended');
  }

  async start(): Promise<boolean> {
    if (!this.stopped) return true;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.options.onError('This browser cannot use the microphone.');
      return false;
    }
    const processing = this.options.echoCancellation ?? true;
    const constraints: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: processing,
      noiseSuppression: processing,
      autoGainControl: processing,
    };
    const attempt = (this.opening += 1);
    const releaseSession = recordingSession();
    let stream: MediaStream;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: this.options.deviceId
            ? { ...constraints, deviceId: { exact: this.options.deviceId } }
            : constraints,
        });
      } catch (error) {
        // The chosen microphone is gone (unplugged, another machine):
        // the default is better than nothing.
        if (!this.options.deviceId || !(error instanceof Error)) throw error;
        if (error.name !== 'OverconstrainedError' && error.name !== 'NotFoundError') throw error;
        stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      }
    } catch (error) {
      releaseSession();
      const denied = error instanceof Error && error.name === 'NotAllowedError';
      this.options.onError(
        denied
          ? 'Microphone access was refused. Allow it in the browser to use voice mode.'
          : 'The microphone could not be opened.'
      );
      return false;
    }
    if (attempt !== this.opening) {
      // Stopped while the microphone was opening: it is not wanted.
      for (const track of stream.getTracks()) track.stop();
      releaseSession();
      return false;
    }
    this.releaseSession = releaseSession;
    this.stream = stream;
    this.stopped = false;
    const context = new AudioContext();
    this.context = context;
    this.source = context.createMediaStreamSource(stream);
    const onFrames = (frames: Float32Array) => {
      // A late block from the worklet after stop() is nothing to judge.
      if (!this.stopped) this.ingest(frames, context.sampleRate);
    };
    try {
      if (!context.audioWorklet) throw new Error('no worklet');
      await context.audioWorklet.addModule('/voice-capture-worklet.js');
      const node = new AudioWorkletNode(context, 'voice-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
      });
      node.port.onmessage = (event: MessageEvent<Float32Array>) => onFrames(event.data);
      this.source.connect(node);
      this.node = node;
    } catch {
      // Older engines: the deprecated processor still does the job. It
      // only runs while connected to the destination, so it is — through
      // a muted gain, with its output written as silence, so nothing of
      // the microphone (or of a stale buffer) ever reaches the speakers.
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        event.outputBuffer.getChannelData(0).fill(0);
        onFrames(event.inputBuffer.getChannelData(0));
      };
      const silence = context.createGain();
      silence.gain.value = 0;
      this.source.connect(processor);
      processor.connect(silence);
      silence.connect(context.destination);
      this.node = processor;
    }
    if (context.state === 'suspended') await context.resume().catch(() => undefined);
    return true;
  }

  stop(): void {
    this.opening += 1;
    this.stopped = true;
    this.reset();
    this.node?.disconnect();
    this.source?.disconnect();
    this.node = null;
    this.source = null;
    void this.context?.close().catch(() => undefined);
    this.context = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.releaseSession?.();
    this.releaseSession = null;
  }

  private reset(): void {
    this.pending = [];
    this.pendingLength = 0;
    this.preRoll = [];
    this.utterance = [];
    this.loudRun = 0;
    this.quietRun = 0;
    this.loudFrames = 0;
    this.held = false;
    this.speaking = false;
  }

  /**
   * Raw frames at the device rate → 16 kHz frames of FRAME_SAMPLES each.
   * The microphone's path in; public so the detector can be fed without
   * one (recorder.test.ts).
   */
  ingest(frames: Float32Array, sampleRate: number): void {
    const resampled = resample(frames, sampleRate, TARGET_SAMPLE_RATE);
    this.pending.push(resampled);
    this.pendingLength += resampled.length;
    while (this.pendingLength >= FRAME_SAMPLES) {
      const all = concat(this.pending);
      const frame = all.subarray(0, FRAME_SAMPLES);
      const rest = all.subarray(FRAME_SAMPLES);
      this.pending = rest.length > 0 ? [new Float32Array(rest)] : [];
      this.pendingLength = rest.length;
      this.judge(new Float32Array(frame));
    }
  }

  private judge(frame: Float32Array): void {
    const level = rms(frame);
    this.options.onLevel?.(Math.min(1, level * 8));
    if (this.muted) return;

    // The floor follows the quiet: fast down, slow up, so a long
    // utterance does not teach the detector that talking is silence. A
    // frame already loud against it barely moves it — in manual mode
    // nothing stops the floor learning while a person talks before
    // pressing Talk, and it must not learn that their voice is the room.
    const threshold = Math.max(MIN_THRESHOLD, this.noiseFloor * 3) * (this.holding ? 2.5 : 1);
    const loud = level > threshold;
    if (!this.speaking) {
      const weight = level < this.noiseFloor ? 0.2 : loud ? 0.002 : 0.02;
      this.noiseFloor = this.noiseFloor * (1 - weight) + level * weight;
    }

    if (!this.speaking) {
      this.preRoll.push(frame);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      // Manual mode: nothing starts on its own; the pre-roll is kept so
      // the word already begun when the button was pressed is not lost.
      if (this.manual) return;
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= START_FRAMES) {
        this.speaking = true;
        this.quietRun = 0;
        this.loudFrames = this.loudRun;
        this.held = false;
        this.utterance = [...this.preRoll];
        this.preRoll = [];
        this.options.onSpeechStart();
      }
      return;
    }

    this.utterance.push(frame);
    this.quietRun = loud ? 0 : this.quietRun + 1;
    if (loud) this.loudFrames += 1;
    if (!this.manual && !this.held && this.loudFrames >= HELD_FRAMES) {
      this.held = true;
      this.options.onSpeechHeld?.(encodeWav(concat(this.utterance)));
    }
    const durationMs = this.durationMs();
    if (this.manual) {
      if (this.quietRun >= SILENCE_FLOOR_FRAMES) this.close(durationMs, 'silence');
      else if (durationMs >= MAX_TAKE_MS) this.close(durationMs, 'length');
      return;
    }
    if (this.quietRun >= END_FRAMES) this.close(durationMs, 'pause');
    else if (durationMs >= MAX_UTTERANCE_MS) this.close(durationMs, 'length');
  }

  private durationMs(): number {
    return this.utterance.length * FRAME_MS;
  }

  private close(durationMs: number, reason: SpeechEndReason): void {
    const frames = this.utterance;
    const spokenMs = this.loudFrames * FRAME_MS;
    this.utterance = [];
    this.speaking = false;
    this.loudRun = 0;
    this.quietRun = 0;
    this.loudFrames = 0;
    this.held = false;
    if (spokenMs >= MIN_UTTERANCE_MS) {
      this.options.onUtterance(encodeWav(concat(frames)), Math.round(durationMs));
    }
    // The last word: a listener may stop the recorder on it.
    this.options.onSpeechEnd?.(reason);
  }
}
