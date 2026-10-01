/**
 * What every binary validator here answers: the bytes to keep — rebuilt
 * from what was understood, never the caller's own bytes where a format
 * allows it — or the reason they were refused, written for the model to
 * act on.
 */

export type BinaryCheck =
  { ok: true; bytes: Buffer; mediaType: string; notes: string[] } | { ok: false; reason: string };

/** Decoded size ceiling for one file the model writes as bytes. */
export const BINARY_MAX_BYTES = 1_048_576;

/** Longest side any image may declare, and the most pixels it may cover. */
export const IMAGE_MAX_SIDE = 16_384;
export const IMAGE_MAX_PIXELS = 50_000_000;

/** Raw (decompressed) pixel data a PNG or TIFF may expand to. */
export const IMAGE_MAX_RAW_BYTES = 32 * 1024 * 1024;

export function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}
