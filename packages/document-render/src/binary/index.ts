/**
 * Bytes a caller was handed → a file that is safe to keep. The one door
 * for everything binary: the extension names the format, the format's own
 * validator must accept the bytes (so a .png that is really a JPEG, an
 * HTML page or a script is refused), and for images what comes out is
 * REBUILT from the parsed pixels rather than the caller's bytes. Nothing
 * here executes or renders the input.
 *
 * Today's caller is the chat's image tool, which runs what an image
 * generation model returned through `sanitizeBytes`; `sanitizeBinary`
 * is the same door for base64.
 */

import { sanitizeJpeg } from './jpeg';
import { checkPdf } from './pdf-guard';
import { sanitizePng } from './png';
import { sanitizeTiff } from './tiff';
import { BINARY_MAX_BYTES, IMAGE_FILE_MAX_BYTES, refuse, type BinaryCheck } from './types';

export { BINARY_MAX_BYTES, IMAGE_FILE_MAX_BYTES } from './types';
export type { BinaryCheck } from './types';
export { coverRgba, decodePng, encodePng, fitWithin, resizeRgba, type RgbaImage } from './pixels';
export { encodeGif, GIF_MAX_FRAMES } from './gif';

const VALIDATORS: Record<string, (bytes: Buffer) => BinaryCheck> = {
  png: sanitizePng,
  jpg: sanitizeJpeg,
  jpeg: sanitizeJpeg,
  tif: sanitizeTiff,
  tiff: sanitizeTiff,
  pdf: checkPdf,
};

/** Extensions that can be validated as bytes. */
export const BINARY_EXTENSIONS: readonly string[] = Object.keys(VALIDATORS);

export function isBinaryExtension(extension: string): boolean {
  return Object.prototype.hasOwnProperty.call(VALIDATORS, extension);
}

/** Base64 characters that decode to at most `bytes`. */
export function base64CharsFor(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** Base64 characters that decode to at most BINARY_MAX_BYTES. */
export const BINARY_MAX_BASE64_CHARS = base64CharsFor(BINARY_MAX_BYTES);

/** Strict base64: no data-URI prefix, no stray characters; whitespace is ignored. */
export function decodeBase64(
  raw: string,
  maxBytes: number = BINARY_MAX_BYTES
): { ok: true; bytes: Buffer } | { ok: false; reason: string } {
  const compact = raw.replace(/\s+/g, '');
  if (compact.length > base64CharsFor(maxBytes)) {
    return { ok: false, reason: `content is larger than the ${maxBytes}-byte limit.` };
  }
  if (compact.length === 0) return { ok: false, reason: 'content must not be empty.' };
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    return {
      ok: false,
      reason:
        'content must be plain base64 (no data: prefix, no URL-safe alphabet, correctly padded).',
    };
  }
  return { ok: true, bytes: Buffer.from(compact, 'base64') };
}

/** The largest file the format may be: images are generated, so they get room; a PDF does not. */
export function maxBytesFor(extension: string): number {
  return extension === 'pdf' ? BINARY_MAX_BYTES : IMAGE_FILE_MAX_BYTES;
}

function validatorFor(extension: string): ((bytes: Buffer) => BinaryCheck) | undefined {
  return Object.prototype.hasOwnProperty.call(VALIDATORS, extension)
    ? VALIDATORS[extension]
    : undefined;
}

/** Bytes a caller already holds (a service's image) → a file safe to keep, or why not. */
export function sanitizeBytes(extension: string, bytes: Buffer): BinaryCheck {
  const validate = validatorFor(extension);
  if (!validate) {
    return refuse(
      `.${extension} cannot be written as bytes; use one of: ${BINARY_EXTENSIONS.join(', ')}.`
    );
  }
  if (bytes.length > maxBytesFor(extension)) {
    return refuse(`content is larger than the ${maxBytesFor(extension)}-byte limit.`);
  }
  return validate(bytes);
}

/** Base64 a caller was handed → a file safe to keep, or why not. */
export function sanitizeBinary(extension: string, base64: string): BinaryCheck {
  if (!validatorFor(extension)) return sanitizeBytes(extension, Buffer.alloc(0));
  const decoded = decodeBase64(base64, maxBytesFor(extension));
  if (!decoded.ok) return refuse(decoded.reason);
  return sanitizeBytes(extension, decoded.bytes);
}
