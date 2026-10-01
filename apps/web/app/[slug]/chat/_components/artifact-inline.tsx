'use client';

/**
 * A file a tool produced, drawn inline in the reply that produced it — the
 * document, the workbook, the PDF itself, at reading size in a bounded,
 * scrollable frame — so the person sees what they got without leaving the
 * thread. Saving it is the Download button beside Copy under the reply.
 * A file with no faithful representation (preview-kind.ts says null) is
 * not drawn at all; its Download button is all there is.
 *
 * Nothing is fetched until the card comes near the screen: a long thread
 * of reports should not pull every one of them on open.
 *
 *   image   <img> from the download URL
 *   pdf     each page painted to a canvas by pdf.js (first PDF_MAX_PAGES)
 *   docx    docx-preview, inside a sandboxed frame: no script runs there,
 *           and the document's own styles cannot leak into the app's
 *   sheet   tables from the /preview route (exceljs, server side)
 *   text    the bytes as text; Markdown rendered, anything else verbatim
 *   extract the text extracted at upload, for a deck or a legacy file
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import { isMarkdown, previewKind, type PreviewKind } from '@/lib/chat/preview-kind';
import type { AttachmentView } from '@/lib/chat/views';
import Markdown from './markdown';

const PDF_MAX_PAGES = 20;
const TEXT_MAX_CHARS = 100_000;

interface PreviewSheet {
  name: string;
  rows: string[][];
  truncated: boolean;
}

function iconFor(kind: PreviewKind): string {
  if (kind === 'image') return ICONS.fileImage;
  if (kind === 'sheet') return ICONS.fileSheet;
  if (kind === 'pdf' || kind === 'docx' || kind === 'text') return ICONS.fileText;
  return ICONS.file;
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringGrid(value: unknown): value is string[][] {
  return (
    Array.isArray(value) &&
    value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'))
  );
}

/** The /preview route's sheets, checked rather than trusted. */
function sheetsOf(body: unknown): PreviewSheet[] {
  if (!isRecord(body) || !Array.isArray(body.sheets)) throw new Error('bad preview');
  return body.sheets.map((sheet: unknown) => {
    if (!isRecord(sheet) || typeof sheet.name !== 'string' || !isStringGrid(sheet.rows)) {
      throw new Error('bad sheet');
    }
    return { name: sheet.name, rows: sheet.rows, truncated: sheet.truncated === true };
  });
}

function extractOf(body: unknown): { text: string; truncated: boolean } {
  if (!isRecord(body) || typeof body.text !== 'string') throw new Error('bad preview');
  return { text: body.text, truncated: body.truncated === true };
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

/** The nearest ancestor that scrolls — the thread — or null for the page itself. */
function scrollParent(element: Element): Element | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

/**
 * True once the element comes within a screen of view. Measured against
 * the thread's own scroller: it clips its content, so a margin on the
 * viewport would never reach a card scrolled out above it.
 */
function useNearScreen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || near) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { root: scrollParent(element), rootMargin: '600px 0px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near];
}

function Failed() {
  return (
    <p className="px-3 py-6 text-center text-xs text-gray-500" data-testid="artifact-inline-error">
      This file could not be shown here. Download it to open it.
    </p>
  );
}

function Loading() {
  return (
    <div className="flex h-40 items-center justify-center text-gray-400 motion-safe:animate-pulse">
      <Icon path={ICONS.file} className="h-8 w-8" />
    </div>
  );
}

function PdfPages({ url }: { url: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'done' | 'failed'>('loading');
  const [more, setMore] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // The legacy build: pdf.js 6 leans on JS newer than iOS Safari and
        // most Chromiums ship (Map#getOrInsertComputed); this one polyfills it.
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
          import.meta.url
        ).toString();
        const bytes = new Uint8Array(await (await fetchOk(url)).arrayBuffer());
        const doc = await pdfjs.getDocument({ data: bytes }).promise;
        const target = host.current;
        if (cancelled || !target) return;
        const width = target.clientWidth || 640;
        const ratio = window.devicePixelRatio || 1;
        const count = Math.min(doc.numPages, PDF_MAX_PAGES);
        for (let number = 1; number <= count; number++) {
          const page = await doc.getPage(number);
          if (cancelled) return;
          const scale = width / page.getViewport({ scale: 1 }).width;
          const viewport = page.getViewport({ scale: scale * ratio });
          const canvas = document.createElement('canvas');
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = '100%';
          canvas.className = 'block bg-white shadow-sm';
          canvas.setAttribute('role', 'img');
          canvas.setAttribute('aria-label', `Page ${number}`);
          target.appendChild(canvas);
          await page.render({ canvas, viewport }).promise;
          if (number === 1 && !cancelled) setState('done');
        }
        if (!cancelled) setMore(doc.numPages - count);
      } catch {
        if (!cancelled) setState('failed');
      }
    })();
    return () => {
      cancelled = true;
      host.current?.replaceChildren();
    };
  }, [url]);
  if (state === 'failed') return <Failed />;
  return (
    <>
      {state === 'loading' ? <Loading /> : null}
      <div
        ref={host}
        className="flex flex-col gap-2 bg-gray-200 p-2 dark:bg-gray-800"
        data-testid="artifact-inline-pdf"
      />
      {more > 0 ? (
        <p className="px-3 py-2 text-xs text-gray-500">
          {more} more page{more === 1 ? '' : 's'} in the download.
        </p>
      ) : null}
    </>
  );
}

const FRAME_DOC =
  '<!doctype html><html><head><meta charset="utf-8"><style>' +
  'html,body{margin:0;background:#fff;color:#111;font-family:system-ui,sans-serif}' +
  'body{padding:12px;overflow-wrap:anywhere}img{max-width:100%;height:auto}' +
  'table{max-width:100%}' +
  '</style></head><body></body></html>';

function DocxFrame({ url }: { url: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<'loading' | 'done' | 'failed'>('loading');
  const [height, setHeight] = useState(160);
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const [{ renderAsync }, blob] = await Promise.all([
          import('docx-preview'),
          fetchOk(url).then((response) => response.blob()),
        ]);
        const doc = frame.current?.contentDocument;
        if (cancelled || !doc) return;
        await renderAsync(blob, doc.body, doc.head, {
          inWrapper: false,
          ignoreWidth: true,
          ignoreHeight: true,
          breakPages: false,
          useBase64URL: true,
          renderComments: false,
          renderChanges: false,
        });
        if (cancelled) return;
        setHeight(doc.documentElement.scrollHeight);
        setState('done');
      } catch {
        if (!cancelled) setState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, url]);
  if (state === 'failed') return <Failed />;
  return (
    <>
      {state === 'loading' ? <Loading /> : null}
      <iframe
        ref={frame}
        title="Document preview"
        // Same origin so the app can lay the document out inside; no
        // allow-scripts, so nothing in it ever runs.
        sandbox="allow-same-origin"
        srcDoc={FRAME_DOC}
        onLoad={() => setLoaded(true)}
        data-testid="artifact-inline-docx"
        className={state === 'done' ? 'block w-full border-0 bg-white' : 'h-0 w-full border-0'}
        style={state === 'done' ? { height } : undefined}
      />
    </>
  );
}

function Sheets({ url }: { url: string }) {
  const [sheets, setSheets] = useState<PreviewSheet[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetchOk(url)
      .then((response) => response.json())
      .then((body: unknown) => {
        if (!cancelled) setSheets(sheetsOf(body));
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (failed) return <Failed />;
  if (!sheets) return <Loading />;
  const sheet = sheets[active];
  if (!sheet || sheet.rows.length === 0) {
    return <p className="px-3 py-6 text-center text-xs text-gray-500">This sheet is empty.</p>;
  }
  const [head, ...body] = sheet.rows;
  return (
    <div data-testid="artifact-inline-sheet">
      {sheets.length > 1 ? (
        <div
          role="tablist"
          className="flex gap-1 overflow-x-auto border-b border-gray-200 px-2 pt-2 dark:border-gray-800"
        >
          {sheets.map((each, index) => (
            <button
              key={each.name}
              type="button"
              role="tab"
              aria-selected={index === active}
              onClick={() => setActive(index)}
              className={`shrink-0 rounded-t-md px-2 py-1 text-xs ${
                index === active
                  ? 'bg-gray-100 font-medium dark:bg-gray-800'
                  : 'text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-900'
              }`}
            >
              {each.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-gray-100 dark:bg-gray-800">
            <tr>
              {head.map((cell, index) => (
                <th
                  key={index}
                  className="border border-gray-200 px-2 py-1 text-left font-semibold whitespace-nowrap dark:border-gray-700"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {head.map((_, index) => (
                  <td
                    key={index}
                    className="border border-gray-200 px-2 py-1 align-top whitespace-nowrap dark:border-gray-700"
                  >
                    {row[index] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.truncated ? (
        <p className="px-3 py-2 text-xs text-gray-500">
          Showing the first part; the download has it all.
        </p>
      ) : null}
    </div>
  );
}

function TextBody({
  url,
  markdown,
  extracted,
}: {
  url: string;
  markdown: boolean;
  extracted: boolean;
}) {
  const [text, setText] = useState<{ value: string; truncated: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = extracted
      ? fetchOk(url)
          .then((response) => response.json())
          .then(extractOf)
      : fetchOk(url)
          .then((response) => response.text())
          .then((value) => ({
            text: value.slice(0, TEXT_MAX_CHARS),
            truncated: value.length > TEXT_MAX_CHARS,
          }));
    load
      .then((body) => {
        if (!cancelled) setText({ value: body.text, truncated: body.truncated });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url, extracted]);
  if (failed) return <Failed />;
  if (!text) return <Loading />;
  return (
    <div data-testid="artifact-inline-text">
      {extracted ? (
        <p className="border-b border-gray-200 px-3 py-1.5 text-[11px] text-gray-500 dark:border-gray-800">
          Text only — the layout is in the download.
        </p>
      ) : null}
      {markdown ? (
        <div className="px-3 py-2">
          <Markdown text={text.value} />
        </div>
      ) : (
        <pre className="px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words">
          {text.value}
        </pre>
      )}
      {text.truncated ? (
        <p className="px-3 py-2 text-xs text-gray-500">
          Showing the first part; the download has it all.
        </p>
      ) : null}
    </div>
  );
}

export default function ArtifactInline({
  tenantId,
  artifact,
}: {
  tenantId: string;
  artifact: AttachmentView;
}) {
  const kind = previewKind(artifact);
  const [ref, near] = useNearScreen<HTMLElement>();
  if (!kind) return null;
  const url = chatClient.attachmentUrl(tenantId, artifact.id);
  const previewUrl = `${url}/preview`;
  let body: ReactNode;
  switch (kind) {
    case 'image':
      body = (
        <img
          src={url}
          alt={artifact.filename}
          className="mx-auto block h-auto max-w-full"
          data-testid="artifact-inline-image"
        />
      );
      break;
    case 'pdf':
      body = <PdfPages url={url} />;
      break;
    case 'docx':
      body = <DocxFrame url={url} />;
      break;
    case 'sheet':
      body = <Sheets url={previewUrl} />;
      break;
    case 'text':
      body = (
        <TextBody
          url={url}
          markdown={isMarkdown(artifact.filename, artifact.contentType)}
          extracted={false}
        />
      );
      break;
    case 'extract':
      body = <TextBody url={previewUrl} markdown={false} extracted />;
      break;
  }
  return (
    <figure
      ref={ref}
      data-testid="artifact-inline"
      data-kind={kind}
      className="my-2 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800"
    >
      <figcaption className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-3 py-1.5 text-xs text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400">
        <Icon path={iconFor(kind)} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium" title={artifact.filename}>
          {artifact.filename}
        </span>
        <span className="shrink-0 text-gray-400">{sizeOf(artifact.sizeBytes)}</span>
      </figcaption>
      <div className="max-h-[28rem] overflow-auto bg-white dark:bg-gray-950">
        {near ? body : <Loading />}
      </div>
    </figure>
  );
}
