/**
 * Saving an SVG the model wrote as a file: the markup as-is (.svg) or drawn
 * to a PNG. The PNG is rasterised by the browser's own <img> pipeline from
 * a blob: URL — in that context scripts never run and nothing external is
 * fetched, so model-written markup can't reach out while being saved.
 */

export interface PreparedSvg {
  /** The markup, with the xmlns an image needs and a pixel size on the root. */
  markup: string;
  width: number;
  height: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const FALLBACK_SIZE = { width: 512, height: 512 };
/** The longest side a saved PNG is drawn at; a bigger canvas fails silently in some browsers. */
const MAX_SIDE = 4096;

/** Whether a block's text is one SVG document (an XML prolog and comments may precede it). */
export function looksLikeSvg(text: string): boolean {
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(
    text
  );
}

function pixels(value: string | null): number | null {
  if (!value) return null;
  const match = /^\s*([0-9]*\.?[0-9]+)\s*(px)?\s*$/i.exec(value);
  if (!match) return null;
  const n = Number.parseFloat(match[1]);
  return n > 0 ? n : null;
}

/**
 * The size the image is drawn at: the root's width and height when they are
 * pixels, else the viewBox's, else a square. One missing side follows the
 * viewBox's aspect ratio.
 */
function sizeOf(root: Element): { width: number; height: number } {
  const box = (root.getAttribute('viewBox') ?? '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const view = box.length === 4 && box[2] > 0 && box[3] > 0 ? { w: box[2], h: box[3] } : null;
  const width = pixels(root.getAttribute('width'));
  const height = pixels(root.getAttribute('height'));
  if (width && height) return { width, height };
  if (view) {
    if (width) return { width, height: (width * view.h) / view.w };
    if (height) return { width: (height * view.w) / view.h, height };
    return { width: view.w, height: view.h };
  }
  return { width: width ?? FALLBACK_SIZE.width, height: height ?? FALLBACK_SIZE.height };
}

/** Parses the markup and readies it for saving; null when it is not a well-formed <svg>. */
export function prepareSvg(source: string): PreparedSvg | null {
  if (!looksLikeSvg(source)) return null;
  const doc = new DOMParser().parseFromString(source.trim(), 'image/svg+xml');
  const root = doc.documentElement;
  if (
    !root ||
    root.localName !== 'svg' ||
    root.namespaceURI !== SVG_NS ||
    doc.getElementsByTagName('parsererror').length > 0
  ) {
    return null;
  }
  const { width, height } = sizeOf(root);
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  return { markup: new XMLSerializer().serializeToString(root), width, height };
}

/** A safe file name stem from a title ("Renkei logo" → "renkei-logo"). */
export function fileStem(title: string): string {
  const stem = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return stem || 'image';
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The browser could not draw this SVG.'));
    image.src = url;
  });
}

/**
 * Draws the SVG to a PNG at `scale`× its size (2 by default, for a sharp
 * result on a dense screen), on a transparent background.
 */
export async function svgToPng(svg: PreparedSvg, scale = 2): Promise<Blob> {
  const fit = Math.min(scale, MAX_SIDE / svg.width, MAX_SIDE / svg.height);
  const url = URL.createObjectURL(new Blob([svg.markup], { type: 'image/svg+xml' }));
  try {
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(svg.width * fit));
    canvas.height = Math.max(1, Math.round(svg.height * fit));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot draw to a canvas.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))),
        'image/png'
      )
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type SvgSaveFormat = 'png' | 'svg';

/** Saves the SVG source as `<name>.png` or `<name>.svg`; rejects with a message fit to show. */
export async function saveSvg(source: string, name: string, format: SvgSaveFormat): Promise<void> {
  const svg = prepareSvg(source);
  if (!svg) throw new Error('This is not a complete, valid SVG, so it can’t be saved as an image.');
  const stem = fileStem(name);
  if (format === 'svg') {
    downloadBlob(new Blob([svg.markup], { type: 'image/svg+xml' }), `${stem}.svg`);
  } else {
    downloadBlob(await svgToPng(svg), `${stem}.png`);
  }
}
