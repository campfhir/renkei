/**
 * PDF text — the one format this package does not hand-roll, and the reason
 * is worth stating so nobody "simplifies" it later.
 *
 * For OOXML, read-only extraction really is a small fraction of a library:
 * unzip, then walk XML. For PDF it is not. Getting text out means parsing
 * xref tables AND xref streams, resolving indirect objects, FlateDecode-ing
 * content streams, tokenizing the content language, and — the part that
 * actually decides whether the output is words or mojibake — mapping glyph
 * codes back to characters through font encodings and ToUnicode CMaps, with
 * CID fonts and a long tail of malformed real-world files. That is most of a
 * PDF implementation, not a subset of one.
 *
 * So pdfjs-dist does it: Apache-2.0, zero dependencies, pinned exact so we
 * own the version and `pnpm audit` can see it. (`unpdf` was rejected for
 * bundling pdfjs inside its own dist, which puts its CVE clock outside our
 * control and beyond `pnpm overrides`.)
 *
 * The import is lazy and failure-tolerant on purpose: importing this package
 * must never drag pdfjs in, and a deployment without the optional dependency
 * degrades to "PDFs are unsupported" rather than crashing the worker.
 *
 * There is NO OCR. A scanned page has no text layer, and this reports that
 * rather than pretending. Adding OCR would mean a runtime model download
 * inside a queue worker, which is not something to do quietly.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { ExtractErrorTag } from './types';

export interface PdfText {
  text: string;
  pages: number;
  /** Pages exist but essentially no text — an image-only scan. */
  scanned: boolean;
}

/**
 * Per PAGE, not per document. A scanned page has no text layer at all, so it
 * yields essentially zero characters, while a real page yields hundreds — the
 * gap is enormous and the threshold only has to sit inside it. An absolute
 * document-wide floor would libel a short but perfectly readable PDF (a
 * one-line memo, a cover sheet) as a scan.
 */
const SCANNED_CHARS_PER_PAGE = 8;

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type PdfLoadingTask = ReturnType<PdfJsModule['getDocument']>;

let cached: PdfJsModule | null | undefined;

async function loadPdfjs(): Promise<PdfJsModule | null> {
  if (cached !== undefined) return cached;
  try {
    // pdfjs polyfills DOMMatrix from @napi-rs/canvas — an optional native
    // package the worker image strips. Text extraction never rasterizes, so
    // an inert stub silences the startup warning without pulling it back in.
    if (!Reflect.has(globalThis, 'DOMMatrix')) {
      Reflect.set(globalThis, 'DOMMatrix', class {});
    }
    // The legacy build is the transpiled-down one Mozilla ships for exactly
    // this: a plain Node runtime with no bundler.
    const module = await import(/* webpackIgnore: true */ 'pdfjs-dist/legacy/build/pdf.mjs');
    // Node has no web worker; pdfjs runs its "fake worker" in-thread but still
    // resolves this path, and its default is relative to process.cwd().
    if (module.GlobalWorkerOptions) {
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      try {
        module.GlobalWorkerOptions.workerSrc =
          require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
      } catch {
        // Resolution failure is not fatal — the fake worker still runs.
      }
    }
    cached = module;
  } catch {
    cached = null;
  }
  return cached;
}

export async function extractPdfText(
  bytes: Uint8Array,
  maxChars: number
): Promise<Result<PdfText, ExtractErrorTag>> {
  const pdfjs = await loadPdfjs();
  if (!pdfjs) {
    return err('UNSUPPORTED_FORMAT' as const, {
      message: 'PDF support requires the pdfjs-dist dependency',
    });
  }

  let task: PdfLoadingTask | null = null;
  try {
    task = pdfjs.getDocument({
      data: bytes,
      // Defense in depth against the malicious-PDF class of advisory.
      isEvalSupported: false,
      enableScripting: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
    const document = await task.promise;

    const parts: string[] = [];
    let used = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages && used < maxChars; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false });
      let pageText = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        pageText += item.str;
        // pdfjs's own reading-order signal; coordinate-based reflow is a
        // rabbit hole that rarely beats it.
        if (item.hasEOL) pageText += '\n';
      }
      const remaining = maxChars - used;
      const clipped = pageText.length > remaining ? pageText.slice(0, remaining) : pageText;
      parts.push(clipped);
      used += clipped.length;
    }

    const text = parts.join('\n').trim();
    return ok({
      text,
      pages: document.numPages,
      scanned: document.numPages > 0 && text.length < document.numPages * SCANNED_CHARS_PER_PAGE,
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'PasswordException') {
      return err('ENCRYPTED' as const, { message: 'the PDF is password protected' });
    }
    return err('CORRUPT' as const, {
      message: error instanceof Error ? error.message : 'unreadable PDF',
    });
  } finally {
    // The fake worker keeps message handlers alive; in a long-running worker
    // process, skipping this leaks per document. Guarded because a throw here
    // would replace a successful extraction with a failure.
    if (typeof task?.destroy === 'function') {
      await task.destroy().catch(() => undefined);
    }
  }
}
