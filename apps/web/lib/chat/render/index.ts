/**
 * Text the model wrote → the binary document the person asked for. The
 * model never produces bytes: it writes Markdown (for a Word document, a
 * PDF or a slide deck) or tabular text (for a workbook), and a library
 * here produces a valid file deterministically. What comes back is the
 * bytes plus any note the model should pass on — a PDF whose text the
 * standard fonts cannot draw, say.
 */

import { renderDocx } from './docx';
import { firstHeading, parseMarkdown } from './markdown-blocks';
import { renderPdf, undrawableCharacters } from './pdf';
import { renderPptx } from './pptx';
import { renderXlsx, sheetsOf } from './xlsx';

export const RENDERED_MEDIA_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;

export type RenderedExtension = keyof typeof RENDERED_MEDIA_TYPES;

export function isRenderedExtension(extension: string): extension is RenderedExtension {
  return Object.prototype.hasOwnProperty.call(RENDERED_MEDIA_TYPES, extension);
}

export interface Rendered {
  bytes: Buffer;
  mediaType: string;
  /** Something the model should tell the person, or act on; empty when nothing. */
  notes: string[];
}

function stem(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

export async function renderDocument(
  extension: RenderedExtension,
  filename: string,
  content: string
): Promise<Rendered> {
  const mediaType: string = RENDERED_MEDIA_TYPES[extension];
  const notes: string[] = [];
  switch (extension) {
    case 'xlsx': {
      const bytes = await renderXlsx(sheetsOf(content, stem(filename)));
      return { bytes, mediaType, notes };
    }
    case 'docx': {
      const blocks = parseMarkdown(content);
      const bytes = await renderDocx(blocks, { title: firstHeading(blocks) ?? stem(filename) });
      return { bytes, mediaType, notes };
    }
    case 'pptx': {
      const blocks = parseMarkdown(content);
      const bytes = await renderPptx(blocks, { title: firstHeading(blocks) ?? stem(filename) });
      return { bytes, mediaType, notes };
    }
    case 'pdf': {
      const blocks = parseMarkdown(content);
      const missing = undrawableCharacters(content);
      if (missing.length > 0) {
        notes.push(
          `The PDF fonts cover Latin text only; these characters were not drawn correctly: ${missing.slice(0, 12).join(' ')}${missing.length > 12 ? ' …' : ''}. Offer a .docx for text in other scripts.`
        );
      }
      const bytes = await renderPdf(blocks, { title: firstHeading(blocks) ?? stem(filename) });
      return { bytes, mediaType, notes };
    }
  }
}
