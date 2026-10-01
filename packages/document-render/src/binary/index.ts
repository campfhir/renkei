/**
 * Bytes the model wrote → a file that is safe to keep. The one door for
 * every caller that accepts base64 from a model (chat_write_binary_file,
 * sandbox_write_binary_file): the extension names the format, the format's
 * own validator must accept the bytes (so a .png that is really a JPEG, an
 * HTML page or a script is refused), and for images what comes out is
 * REBUILT from the parsed pixels rather than the caller's bytes. Nothing
 * here executes or renders the input.
 */

import { sanitizeJpeg } from './jpeg';
import { checkPdf } from './pdf-guard';
import { sanitizePng } from './png';
import { sanitizeTiff } from './tiff';
import { BINARY_MAX_BYTES, refuse, type BinaryCheck } from './types';

export { BINARY_MAX_BYTES } from './types';
export type { BinaryCheck } from './types';

const VALIDATORS: Record<string, (bytes: Buffer) => BinaryCheck> = {
  png: sanitizePng,
  jpg: sanitizeJpeg,
  jpeg: sanitizeJpeg,
  tif: sanitizeTiff,
  tiff: sanitizeTiff,
  pdf: checkPdf,
};

/** Extensions a model may write as bytes. */
export const BINARY_EXTENSIONS: readonly string[] = Object.keys(VALIDATORS);

export function isBinaryExtension(extension: string): boolean {
  return Object.prototype.hasOwnProperty.call(VALIDATORS, extension);
}

/** Base64 characters that decode to at most BINARY_MAX_BYTES. */
export const BINARY_MAX_BASE64_CHARS = Math.ceil(BINARY_MAX_BYTES / 3) * 4;

/** Strict base64: no data-URI prefix, no stray characters; whitespace is ignored. */
export function decodeBase64(
  raw: string
): { ok: true; bytes: Buffer } | { ok: false; reason: string } {
  const compact = raw.replace(/\s+/g, '');
  if (compact.length > BINARY_MAX_BASE64_CHARS) {
    return { ok: false, reason: `content is larger than the ${BINARY_MAX_BYTES}-byte limit.` };
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

export function sanitizeBinary(extension: string, base64: string): BinaryCheck {
  const validate = Object.prototype.hasOwnProperty.call(VALIDATORS, extension)
    ? VALIDATORS[extension]
    : undefined;
  if (!validate) {
    return refuse(
      `.${extension} cannot be written as bytes; use one of: ${BINARY_EXTENSIONS.join(', ')}.`
    );
  }
  const decoded = decodeBase64(base64);
  if (!decoded.ok) return refuse(decoded.reason);
  if (decoded.bytes.length > BINARY_MAX_BYTES) {
    return refuse(`content is larger than the ${BINARY_MAX_BYTES}-byte limit.`);
  }
  return validate(decoded.bytes);
}
