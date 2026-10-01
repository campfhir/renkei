/**
 * What every binary validator here answers: the bytes to keep — rebuilt
 * from what was understood, never the caller's own bytes where a format
 * allows it — or the reason they were refused, written for the model to
 * act on.
 */

export type BinaryCheck =
  | {
      ok: true;
      bytes: Buffer;
      mediaType: string;
      notes: string[];
      /** Pixel size, for an image whose header was read; absent otherwise. */
      width?: number;
      height?: number;
    }
  | { ok: false; reason: string };

/** Decoded size ceiling for a PDF (and for bytes a caller decodes from base64 itself). */
export const BINARY_MAX_BYTES = 1_048_576;

/**
 * Ceiling for an image a service generated for the person — a 1024-pixel
 * gpt-image PNG is a few MB and a 4K one tens of them. Matches the chat's
 * own artifact limit, past which the file could not be kept anyway.
 */
export const IMAGE_FILE_MAX_BYTES = 25_000_000;

/** Longest side any image may declare, and the most pixels it may cover. */
export const IMAGE_MAX_SIDE = 16_384;
export const IMAGE_MAX_PIXELS = 50_000_000;

/** Raw (decompressed) pixel data a PNG or TIFF may expand to: room for 4K at 16 bits with alpha. */
export const IMAGE_MAX_RAW_BYTES = 96 * 1024 * 1024;

export function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}
