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
 * utterance is complete — which is what lets the person interrupt a reply
 * mid-sentence: the thread silences the voice and cancels the turn on that
 * signal, and sends the utterance when it closes.
 *
 * Echo cancellation is asked of the browser so the assistant's own voice
 * from the speakers is not heard as the person talking; on a device that
 * cannot cancel it, `holdWhileSpeaking` raises the bar while the assistant
 * speaks instead.
 */

import { concat, encodeWav, resample, rms, TARGET_SAMPLE_RATE } from './wav';

export interface RecorderOptions {
  /**
   * Ask the browser to cancel the speakers' echo from the microphone.
   * Default true; off where the platform's voice-call path degrades
   * playback while the microphone is open (lib/voice/device-settings.ts).
   */
  echoCancellation?: boolean;
  onSpeechStart: () => void;
  onUtterance: (wav: ArrayBuffer, durationMs: number) => void;
  /** Loudness, 0–1, for a level meter; called often. */
  onLevel?: (level: number) => void;
  onError: (message: string) => void;
}

/** Frames this long are what the detector judges; ~50 ms at 16 kHz. */
const FRAME_SAMPLES = 800;
/** Kept before a detected start, so the first syllable is not lost. */
const PRE_ROLL_FRAMES = 6;
/** Consecutive loud frames that count as speech starting. */
const START_FRAMES = 3;
/** Quiet frames that close an utterance: ~800 ms of silence. */
const END_FRAMES = 16;
/** Shorter than this is a click or a cough, not a sentence. */
const MIN_UTTERANCE_MS = 300;
/** Longer than this is sent as it is, so a monologue still gets an answer. */
const MAX_UTTERANCE_MS = 45_000;
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
  private speaking = false;
  private noiseFloor = 0.004;
  private muted = false;
  private holding = false;
  private stopped = true;

  constructor(private readonly options: RecorderOptions) {}

  /** While true, sound is ignored — a mute button, or the mic simply idle. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.reset();
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

  async start(): Promise<boolean> {
    if (!this.stopped) return true;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.options.onError('This browser cannot use the microphone.');
      return false;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: this.options.echoCancellation ?? true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      const denied = error instanceof Error && error.name === 'NotAllowedError';
      this.options.onError(
        denied
          ? 'Microphone access was refused. Allow it in the browser to use voice mode.'
          : 'The microphone could not be opened.'
      );
      return false;
    }
    this.stream = stream;
    this.stopped = false;
    const context = new AudioContext();
    this.context = context;
    this.source = context.createMediaStreamSource(stream);
    const onFrames = (frames: Float32Array) => this.ingest(frames, context.sampleRate);
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
  }

  private reset(): void {
    this.pending = [];
    this.pendingLength = 0;
    this.preRoll = [];
    this.utterance = [];
    this.loudRun = 0;
    this.quietRun = 0;
    this.speaking = false;
  }

  /** Raw frames at the device rate → 16 kHz frames of FRAME_SAMPLES each. */
  private ingest(frames: Float32Array, sampleRate: number): void {
    if (this.stopped) return;
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
    // utterance does not teach the detector that talking is silence.
    if (!this.speaking) {
      this.noiseFloor =
        level < this.noiseFloor
          ? this.noiseFloor * 0.8 + level * 0.2
          : this.noiseFloor * 0.98 + level * 0.02;
    }
    const threshold = Math.max(MIN_THRESHOLD, this.noiseFloor * 3) * (this.holding ? 2.5 : 1);
    const loud = level > threshold;

    if (!this.speaking) {
      this.preRoll.push(frame);
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift();
      this.loudRun = loud ? this.loudRun + 1 : 0;
      if (this.loudRun >= START_FRAMES) {
        this.speaking = true;
        this.quietRun = 0;
        this.utterance = [...this.preRoll];
        this.preRoll = [];
        this.options.onSpeechStart();
      }
      return;
    }

    this.utterance.push(frame);
    this.quietRun = loud ? 0 : this.quietRun + 1;
    const durationMs = (this.utterance.length * FRAME_SAMPLES * 1000) / TARGET_SAMPLE_RATE;
    if (this.quietRun >= END_FRAMES || durationMs >= MAX_UTTERANCE_MS) this.close(durationMs);
  }

  private close(durationMs: number): void {
    const frames = this.utterance;
    const spokenMs = durationMs - (this.quietRun * FRAME_SAMPLES * 1000) / TARGET_SAMPLE_RATE;
    this.utterance = [];
    this.speaking = false;
    this.loudRun = 0;
    this.quietRun = 0;
    if (spokenMs < MIN_UTTERANCE_MS) return;
    this.options.onUtterance(encodeWav(concat(frames)), Math.round(durationMs));
  }
}
