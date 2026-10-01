/**
 * PDF, gated. A PDF cannot be cheaply rebuilt the way an image can, so
 * this refuses anything that can act: scripts, auto-run and
 * launch/submit/URI actions, embedded files, forms (AcroForm/XFA),
 * rich media, encryption, and the structures that could hide those from a
 * scan (object streams, hybrid xref streams) or exploit a decoder (JBIG2,
 * JPX). What is left is pages, text, fonts and DCT/Flate images.
 *
 * The scan reads the whole file as bytes, not as a parsed structure, so a
 * parser difference between this and a viewer cannot hide a name from it.
 * Names are matched after decoding #xx escapes (`/J#53` is `/JS`). The
 * price is that a name appearing by chance in compressed stream data
 * refuses the file — rare for the small files a model writes, and the
 * model is told which name to look for.
 */

import { BINARY_MAX_BYTES, refuse, type BinaryCheck } from './types';

/** Name → why it is refused. */
const FORBIDDEN_NAMES: Record<string, string> = {
  JS: 'scripts',
  JavaScript: 'scripts',
  AA: 'automatic actions',
  OpenAction: 'run-on-open actions',
  Launch: 'launch actions',
  URI: 'link-out actions',
  GoToR: 'remote-file actions',
  GoToE: 'embedded-file actions',
  SubmitForm: 'form submission',
  ImportData: 'form data import',
  Rendition: 'media',
  Movie: 'media',
  Sound: 'media',
  RichMedia: 'rich media',
  '3D': '3D content',
  GoTo3DView: '3D content',
  EmbeddedFile: 'embedded files',
  EmbeddedFiles: 'embedded files',
  FileAttachment: 'file attachments',
  XFA: 'XFA forms',
  AcroForm: 'interactive forms',
  Encrypt: 'encryption',
  ObjStm: 'object streams, which can hide content from a scan',
  XRefStm: 'hybrid cross-reference streams',
  JBIG2Decode: 'the JBIG2 image decoder',
  JPXDecode: 'the JPEG 2000 image decoder',
  Crypt: 'crypt filters',
};

const TAIL_WINDOW = 2048;

function decodeName(raw: string): string {
  return raw.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

export function checkPdf(input: Buffer): BinaryCheck {
  if (input.length > BINARY_MAX_BYTES) return refuse('The PDF is too large.');
  if (!/^%PDF-(1\.[0-7]|2\.0)[\r\n]/.test(input.toString('latin1', 0, 10))) {
    return refuse('This is not a PDF: it must begin with %PDF-1.x or %PDF-2.0 at byte 0.');
  }
  const text = input.toString('latin1');
  const tail = text.slice(Math.max(0, text.length - TAIL_WINDOW));
  if (!/%%EOF\s*$/.test(tail)) {
    return refuse('The PDF must end with %%EOF (nothing may follow it).');
  }
  if (!/startxref\s+\d+\s+%%EOF\s*$/.test(tail)) {
    return refuse('The PDF has no startxref pointer before its end marker.');
  }
  if (!/\/Type\s*\/Catalog/.test(text) && !/\/Root\s+\d+\s+\d+\s+R/.test(text)) {
    return refuse('The PDF has no document catalog (/Root).');
  }

  const found = new Set<string>();
  // PDF name characters run to whitespace or a delimiter.
  for (const match of text.matchAll(/\/([^\s()<>[\]{}/%]*)/g)) {
    const name = decodeName(match[1]!);
    if (Object.prototype.hasOwnProperty.call(FORBIDDEN_NAMES, name)) found.add(name);
  }
  if (found.size > 0) {
    const list = [...found].map((n) => `/${n} (${FORBIDDEN_NAMES[n]})`).join(', ');
    return refuse(
      `The PDF contains features that are not accepted: ${list}. Write a plain document of pages, text, fonts and images.`
    );
  }
  return { ok: true, bytes: input, mediaType: 'application/pdf', notes: [] };
}
