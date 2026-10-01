/**
 * How a stored file can be shown in the app before anyone downloads it.
 * Decided from the content type, falling back to the extension (a tool's
 * file often arrives as application/octet-stream), and from whether text
 * was extracted at upload. Pure — the thread, the preview window and their
 * tests share it.
 *
 *   image   the bytes as an <img>
 *   pdf     every page drawn with pdf.js
 *   docx    laid out by docx-preview, in a sandboxed frame
 *   pptx    the first slide drawn by pptx-preview, in a sandboxed frame
 *   text    the bytes as text (Markdown rendered, anything else verbatim)
 *   sheet   a workbook or CSV as tables, parsed on the server
 *   extract the text extracted at upload — a legacy Office file, say
 *   null    nothing to show; download it
 */

export type PreviewKind = 'image' | 'pdf' | 'docx' | 'pptx' | 'text' | 'sheet' | 'extract';

/** Past this, a preview is more wait than help; download instead. */
export const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

const IMAGE = /^image\/(png|jpeg|gif|webp)$/;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/javascript',
  'application/typescript',
  'application/sql',
]);
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'xml',
  'yaml',
  'yml',
  'html',
  'htm',
  'css',
  'js',
  'ts',
  'tsx',
  'jsx',
  'py',
  'sql',
  'sh',
  'log',
  'ini',
  'toml',
  'hl7',
]);

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

export function isMarkdown(filename: string, contentType: string): boolean {
  const extension = extensionOf(filename);
  return contentType === 'text/markdown' || extension === 'md' || extension === 'markdown';
}

export function previewKind(file: {
  filename: string;
  contentType: string;
  sizeBytes: number;
  extractStatus: string;
}): PreviewKind | null {
  if (file.sizeBytes > PREVIEW_MAX_BYTES) return null;
  const type = file.contentType.toLowerCase();
  const extension = extensionOf(file.filename);
  if (IMAGE.test(type) || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) {
    return 'image';
  }
  if (type === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (type === DOCX || extension === 'docx') return 'docx';
  if (type === PPTX || extension === 'pptx') return 'pptx';
  if (type === XLSX || extension === 'xlsx' || type === 'text/csv' || extension === 'csv') {
    return 'sheet';
  }
  if (type.startsWith('text/') || TEXT_TYPES.has(type) || TEXT_EXTENSIONS.has(extension)) {
    return 'text';
  }
  if (file.extractStatus === 'done') return 'extract';
  return null;
}
