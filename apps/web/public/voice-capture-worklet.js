/**
 * The microphone tap for the chat's voice mode: copies each 128-frame
 * block of the first input channel to the main thread, where the recorder
 * (lib/voice/recorder.ts) resamples, detects speech and encodes. Runs on
 * the audio thread, so it does nothing else — no analysis here.
 *
 * A plain script in public/ because a worklet is loaded by URL, not
 * imported: the bundler never sees it, and it must stay dependency-free.
 */

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      // Copy: the block's buffer is reused by the audio thread.
      this.port.postMessage(new Float32Array(channel));
    }
    return true;
  }
}

registerProcessor('voice-capture', VoiceCaptureProcessor);
