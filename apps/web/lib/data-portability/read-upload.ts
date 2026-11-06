/**
 * An import upload as text files: a zip (ChatGPT's, Claude's, a Takeout,
 * Renkei's own) unpacked to the members the parsers read — JSON, Markdown
 * and text, nothing under `__MACOSX/` — or a single file or pasted text as
 * it is. Unpacking counts bytes as they inflate and stops past a ceiling,
 * so a small zip that unpacks to gigabytes is refused instead of filling
 * memory; the ceiling is far above any real assistant export's text.
 */

import JSZip from 'jszip';
import type { ImportFile } from './types';

/** The most the import route reads from a request (the proxy's own cap is 110MB). */
export const IMPORT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** The most text a zip may unpack to, across the members read. */
export const IMPORT_MAX_UNPACKED_BYTES = 400 * 1024 * 1024;

const READABLE = /\.(json|md|markdown|txt)$/i;

export type ReadUploadResult =
  { ok: true; files: ImportFile[] } | { ok: false; reason: 'too-large' | 'unreadable' | 'empty' };

function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

/** One member's text, or null once the shared budget runs out. */
function readBounded(file: JSZip.JSZipObject, budget: { left: number }): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    const parts: string[] = [];
    let done = false;
    const stream = file.nodeStream('nodebuffer');
    stream.on('data', (chunk: Buffer) => {
      if (done) return;
      budget.left -= chunk.length;
      if (budget.left < 0) {
        done = true;
        stream.pause();
        stream.removeAllListeners('data');
        resolve(null);
        return;
      }
      parts.push(decoder.decode(chunk, { stream: true }));
    });
    stream.on('end', () => {
      if (done) return;
      done = true;
      parts.push(decoder.decode());
      resolve(parts.join(''));
    });
    stream.on('error', (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

export async function readUploadFiles(
  name: string,
  bytes: Uint8Array,
  options: { maxUnpackedBytes?: number } = {}
): Promise<ReadUploadResult> {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (!isZip(bytes)) {
    return {
      ok: true,
      files: [{ name: name || 'pasted.md', text: new TextDecoder().decode(bytes) }],
    };
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const budget = { left: options.maxUnpackedBytes ?? IMPORT_MAX_UNPACKED_BYTES };
  const members = Object.values(zip.files).filter(
    (file) => !file.dir && READABLE.test(file.name) && !file.name.startsWith('__MACOSX/')
  );
  const files: ImportFile[] = [];
  for (const member of members) {
    let text: string | null;
    try {
      text = await readBounded(member, budget);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    if (text === null) return { ok: false, reason: 'too-large' };
    files.push({ name: member.name, text });
  }
  return files.length > 0 ? { ok: true, files } : { ok: false, reason: 'empty' };
}
