'use client';

/**
 * A file a tool produced, shown in the reply that produced it as what it
 * is: the first page of a document, the first slide of a deck, the corner
 * of a workbook's first sheet — a small picture of the thing, the way a
 * file manager shows a thumbnail — with its name and a Download right
 * under it. A file with no faithful picture (preview-kind.ts says null)
 * is just its name and the Download.
 *
 * Every picture is laid out at the size it was made for (a Letter page, a
 * 16:9 slide) and scaled down to the card, so a page keeps a page's shape
 * and its proportions, whatever the screen. Nothing is fetched until the
 * card comes near the visible part of the thread.
 *
 *   image   <img> from the download URL
 *   pdf     page 1 painted to a canvas by pdf.js
 *   docx    page 1 laid out by docx-preview  } in a sandboxed frame: no
 *   pptx    slide 1 drawn by pptx-preview    } script runs, no style leaks
 *   sheet   the first sheet's corner, as a grid, from the /preview route
 *   text    the start of the text on a page; Markdown rendered
 *   extract the start of the text extracted at upload, on a page
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { chatClient } from '@/lib/chat/client';
import { isMarkdown, previewKind, type PreviewKind } from '@/lib/chat/preview-kind';
import type { AttachmentView } from '@/lib/chat/views';
import FileCaption from './file-caption';
import Markdown from './markdown';

/** A US Letter page at 96 dpi, the size docx-preview lays a page out at. */
const PAGE = { width: 816, height: 1056 };
/** A page for plain text: Letter's shape, at a size its text reads well scaled down. */
const TEXT_PAGE = { width: 612, height: 792 };
const SLIDE = { width: 960, height: 540 };
const SHEET = { width: 640, height: 400 };
/** Enough text to fill one page; the rest is in the download. */
const TEXT_CHARS = 4_000;

interface PreviewCell {
  v: string;
  b?: true;
  n?: true;
}

interface PreviewSheet {
  name: string;
  rows: PreviewCell[][];
  widths: number[];
  sheetCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCell(value: unknown): value is PreviewCell {
  return isRecord(value) && typeof value.v === 'string';
}

/** The /preview route's sheet, checked rather than trusted. */
function sheetOf(body: unknown): PreviewSheet {
  if (!isRecord(body) || !isRecord(body.sheet)) throw new Error('bad preview');
  const { name, rows, widths, sheetCount } = body.sheet;
  if (
    typeof name !== 'string' ||
    !Array.isArray(rows) ||
    !rows.every((row) => Array.isArray(row) && row.every(isCell)) ||
    !Array.isArray(widths) ||
    !widths.every((width) => typeof width === 'number')
  ) {
    throw new Error('bad sheet');
  }
  return { name, rows, widths, sheetCount: typeof sheetCount === 'number' ? sheetCount : 1 };
}

function extractOf(body: unknown): string {
  if (!isRecord(body) || typeof body.text !== 'string') throw new Error('bad preview');
  return body.text;
}

function iconFor(kind: PreviewKind | null): string {
  if (kind === 'image') return ICONS.fileImage;
  if (kind === 'sheet') return ICONS.fileSheet;
  if (kind === null) return ICONS.file;
  return ICONS.fileText;
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

/**
 * A sheet of the given design size, scaled to whatever width the card has:
 * the children lay out at `width` × `height` and are shrunk to fit, so a
 * page keeps its proportions on a phone and on a desktop alike.
 */
function Scaled({
  width,
  height,
  children,
  testId,
}: {
  width: number;
  height: number;
  children: ReactNode;
  testId?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setScale(element.clientWidth / width);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [width]);
  return (
    <div
      ref={box}
      className="relative w-full overflow-hidden"
      style={{ aspectRatio: `${width} / ${height}` }}
      data-testid={testId}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{
          width,
          height,
          transform: `scale(${scale})`,
          visibility: scale ? undefined : 'hidden',
        }}
      >
        {children}
      </div>
    </div>
  );
}

type Load = 'loading' | 'done' | 'failed';

function Blank({ width, height, state }: { width: number; height: number; state: Load }) {
  return (
    <div
      className={`absolute inset-0 flex items-center justify-center text-gray-300 ${
        state === 'loading' ? 'motion-safe:animate-pulse' : ''
      }`}
      style={{ width, height }}
      data-testid={state === 'failed' ? 'artifact-inline-error' : undefined}
    >
      {state === 'failed' ? (
        <span className="px-8 text-center text-2xl text-gray-500">
          No preview — download to open it.
        </span>
      ) : (
        <Icon path={ICONS.file} className="h-24 w-24" />
      )}
    </div>
  );
}

function PdfFirstPage({ url }: { url: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<Load>('loading');
  const [shape, setShape] = useState(PAGE);
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
        const page = await doc.getPage(1);
        const target = canvas.current;
        if (cancelled || !target) return;
        const natural = page.getViewport({ scale: 1 });
        // Painted at twice the page's CSS size: sharp once scaled to the card.
        const viewport = page.getViewport({ scale: (PAGE.width / natural.width) * 2 });
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        setShape({
          width: PAGE.width,
          height: Math.round((PAGE.width * natural.height) / natural.width),
        });
        await page.render({ canvas: target, viewport }).promise;
        if (!cancelled) setState('done');
      } catch {
        if (!cancelled) setState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);
  return (
    <Scaled width={shape.width} height={shape.height} testId="artifact-inline-pdf">
      <canvas
        ref={canvas}
        role="img"
        aria-label="Page 1"
        className="block bg-white"
        style={{ width: shape.width, height: shape.height }}
      />
      {state === 'done' ? null : <Blank {...shape} state={state} />}
    </Scaled>
  );
}

const FRAME_DOC =
  '<!doctype html><html><head><meta charset="utf-8"><style>' +
  'html,body{margin:0;background:#fff;color:#111;overflow:hidden}' +
  '</style></head><body></body></html>';

/**
 * A blank, sandboxed page the app lays a document out in: same origin so it
 * can write into it, no allow-scripts so nothing in the document ever runs,
 * and its own stylesheet so the document's styles stay inside.
 */
function useFrame(
  url: string,
  draw: (bytes: ArrayBuffer, doc: Document) => Promise<void>
): [React.RefObject<HTMLIFrameElement | null>, () => void, Load] {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [state, setState] = useState<Load>('loading');
  const drawRef = useRef(draw);
  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    void (async () => {
      try {
        const bytes = await (await fetchOk(url)).arrayBuffer();
        const doc = frame.current?.contentDocument;
        if (cancelled || !doc) return;
        await drawRef.current(bytes, doc);
        if (!cancelled) setState('done');
      } catch {
        if (!cancelled) setState('failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, url]);
  return [frame, () => setLoaded(true), state];
}

async function drawDocx(bytes: ArrayBuffer, doc: Document): Promise<void> {
  const { renderAsync } = await import('docx-preview');
  await renderAsync(bytes, doc.body, doc.head, {
    inWrapper: false,
    breakPages: true,
    ignoreLastRenderedPageBreak: false,
    useBase64URL: true,
    renderComments: false,
    renderChanges: false,
    renderHeaders: true,
    renderFooters: true,
  });
}

/**
 * A deck's package with every manifest entry for a part it lacks taken out.
 * PowerPoint shrugs these off, and pptxgenjs (our own file tools) writes
 * one for a second slide master that is never there; pptx-preview reads
 * every entry, throws on the missing part, and swallows it into a deck
 * with no slides.
 */
async function withoutMissingParts(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(bytes);
  const types = zip.file('[Content_Types].xml');
  if (!types) return bytes;
  const xml = await types.async('text');
  const cleaned = xml.replace(
    /<Override\b[^>]*\bPartName="\/([^"]+)"[^>]*\/>/g,
    (entry, part: string) => (zip.file(part) ? entry : '')
  );
  if (cleaned === xml) return bytes;
  zip.file('[Content_Types].xml', cleaned);
  return zip.generateAsync({ type: 'arraybuffer' });
}

async function drawPptx(bytes: ArrayBuffer, doc: Document): Promise<void> {
  const { init } = await import('pptx-preview');
  const previewer = init(doc.body, { width: SLIDE.width, height: SLIDE.height, mode: 'slide' });
  await previewer.load(await withoutMissingParts(bytes));
  if (previewer.slideCount === 0) throw new Error('no slides');
  previewer.renderSingleSlide(0);
}

function FramedFirstPage({
  url,
  size,
  draw,
  title,
  testId,
}: {
  url: string;
  size: { width: number; height: number };
  draw: (bytes: ArrayBuffer, doc: Document) => Promise<void>;
  title: string;
  testId: string;
}) {
  const [frame, onLoad, state] = useFrame(url, draw);
  return (
    <Scaled width={size.width} height={size.height}>
      <iframe
        ref={frame}
        title={title}
        sandbox="allow-same-origin"
        srcDoc={FRAME_DOC}
        onLoad={onLoad}
        tabIndex={-1}
        data-testid={testId}
        className="pointer-events-none block border-0 bg-white"
        style={{ width: size.width, height: size.height }}
      />
      {state === 'done' ? null : <Blank {...size} state={state} />}
    </Scaled>
  );
}

function columnName(index: number): string {
  let name = '';
  for (let number = index + 1; number > 0; number = Math.floor((number - 1) / 26)) {
    name = String.fromCharCode(65 + ((number - 1) % 26)) + name;
  }
  return name;
}

/** Excel's width is in characters of its default font: about 7px each, plus padding. */
const columnPx = (width: number) => Math.round(width * 7 + 5);
const ROW_PX = 20;
const NUMBER_COLUMN_PX = 36;

/**
 * The sheet's cells, padded with empty ones out to the edges of the
 * picture: a spreadsheet reads as one by its gridlines running on past the
 * data, not by a few cells floating on white.
 */
function filled(sheet: PreviewSheet): { rows: PreviewCell[][]; widths: number[] } {
  const widths = [...sheet.widths];
  let across = NUMBER_COLUMN_PX + widths.reduce((sum, width) => sum + columnPx(width), 0);
  while (across < SHEET.width) {
    widths.push(8.43);
    across += columnPx(8.43);
  }
  const down = Math.ceil(SHEET.height / ROW_PX);
  const rows = Array.from({ length: Math.max(down, sheet.rows.length) }, (_, index) => {
    const row = sheet.rows[index] ?? [];
    return widths.map((_, column) => row[column] ?? { v: '' });
  });
  return { rows, widths };
}

function SheetCorner({ url }: { url: string }) {
  const [sheet, setSheet] = useState<PreviewSheet | null>(null);
  const [state, setState] = useState<Load>('loading');
  useEffect(() => {
    let cancelled = false;
    fetchOk(url)
      .then((response) => response.json())
      .then((body: unknown) => {
        if (cancelled) return;
        setSheet(sheetOf(body));
        setState('done');
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  const head = 'border-r border-b border-gray-300 bg-gray-100 text-gray-500 font-normal';
  const grid = sheet ? filled(sheet) : null;
  return (
    <Scaled width={SHEET.width} height={SHEET.height} testId="artifact-inline-sheet">
      <div className="h-full w-full bg-white text-[13px] text-gray-900">
        {grid ? (
          <table
            className="table-fixed border-collapse"
            style={{ fontFamily: 'Calibri, Arial, sans-serif' }}
          >
            <colgroup>
              <col style={{ width: NUMBER_COLUMN_PX }} />
              {grid.widths.map((width, index) => (
                <col key={index} style={{ width: columnPx(width) }} />
              ))}
            </colgroup>
            <thead>
              <tr className="h-5">
                <th className={head} />
                {grid.widths.map((_, index) => (
                  <th key={index} className={`${head} text-center`}>
                    {columnName(index)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row, rowIndex) => (
                <tr key={rowIndex} style={{ height: ROW_PX }}>
                  <th className={`${head} text-center`}>{rowIndex + 1}</th>
                  {row.map((cell, index) => (
                    <td
                      key={index}
                      className={`overflow-hidden border-r border-b border-gray-200 px-1 whitespace-nowrap ${
                        cell.n ? 'text-right' : 'text-left'
                      } ${cell.b ? 'font-bold' : ''}`}
                    >
                      {cell.v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
      {sheet && sheet.sheetCount > 1 ? (
        <div className="absolute right-0 bottom-0 left-0 border-t border-gray-300 bg-gray-50 px-2 py-1 text-[13px] text-gray-600">
          <span className="border-b-2 border-green-700 px-2 font-medium text-gray-900">
            {sheet.name}
          </span>
          <span className="ml-2">+{sheet.sheetCount - 1} more</span>
        </div>
      ) : null}
      {state === 'done' ? null : <Blank {...SHEET} state={state} />}
    </Scaled>
  );
}

function TextPage({
  url,
  markdown,
  extracted,
}: {
  url: string;
  markdown: boolean;
  extracted: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<Load>('loading');
  useEffect(() => {
    let cancelled = false;
    const load = extracted
      ? fetchOk(url)
          .then((response) => response.json())
          .then(extractOf)
      : fetchOk(url).then((response) => response.text());
    load
      .then((value) => {
        if (cancelled) return;
        setText(value.slice(0, TEXT_CHARS));
        setState('done');
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [url, extracted]);
  return (
    <Scaled width={TEXT_PAGE.width} height={TEXT_PAGE.height} testId="artifact-inline-text">
      <div className="h-full w-full overflow-hidden bg-white px-14 py-12 text-[15px] leading-relaxed text-gray-900">
        {text === null ? null : markdown ? (
          <Markdown text={text} />
        ) : (
          <pre className="font-mono text-[13px] whitespace-pre-wrap break-words">{text}</pre>
        )}
      </div>
      {state === 'done' ? null : <Blank {...TEXT_PAGE} state={state} />}
    </Scaled>
  );
}

export default function ArtifactInline({
  artifact,
}: {
  artifact: AttachmentView;
}) {
  const kind = previewKind(artifact);
  const [ref, near] = useNearScreen<HTMLElement>();
  const url = chatClient.attachmentUrl(tenantId, artifact.id);
  const previewUrl = `${url}/preview`;

  let picture: ReactNode = null;
  if (kind !== null && near) {
    switch (kind) {
      case 'image':
        picture = (
          <img
            src={url}
            alt={artifact.filename}
            className="block h-auto max-h-96 max-w-full"
            data-testid="artifact-inline-image"
          />
        );
        break;
      case 'pdf':
        picture = <PdfFirstPage url={url} />;
        break;
      case 'docx':
        picture = (
          <FramedFirstPage
            url={url}
            size={PAGE}
            draw={drawDocx}
            title="First page"
            testId="artifact-inline-docx"
          />
        );
        break;
      case 'pptx':
        picture = (
          <FramedFirstPage
            url={url}
            size={SLIDE}
            draw={drawPptx}
            title="First slide"
            testId="artifact-inline-pptx"
          />
        );
        break;
      case 'sheet':
        picture = <SheetCorner url={previewUrl} />;
        break;
      case 'text':
        picture = (
          <TextPage
            url={url}
            markdown={isMarkdown(artifact.filename, artifact.contentType)}
            extracted={false}
          />
        );
        break;
      case 'extract':
        picture = <TextPage url={previewUrl} markdown={false} extracted />;
        break;
    }
  }
  // A page or a slide is a white sheet on the thread, lifted by a shadow
  // rather than boxed in by a border; a deck is wider than a page.
  const frameClass =
    kind === 'image'
      ? 'w-fit max-w-full overflow-hidden rounded-md'
      : `${kind === 'pptx' || kind === 'sheet' ? 'max-w-md' : 'max-w-sm'} w-full overflow-hidden rounded-sm bg-white shadow-md`;
  return (
    <figure ref={ref} data-testid="artifact-inline" data-kind={kind ?? 'none'} className="my-3">
      {kind !== null ? (
        <div className={frameClass}>
          {picture ?? (
            <div
              className="w-full bg-white"
              style={{
                aspectRatio:
                  kind === 'pptx'
                    ? '16 / 9'
                    : kind === 'sheet'
                      ? `${SHEET.width} / ${SHEET.height}`
                      : kind === 'image'
                        ? '4 / 3'
                        : '8.5 / 11',
              }}
            />
          )}
        </div>
      ) : null}
      <FileCaption
        href={url}
        filename={artifact.filename}
        sizeBytes={artifact.sizeBytes}
        icon={iconFor(kind)}
      />
    </figure>
  );
}
