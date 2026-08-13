/**
 * The slice of pdfjs-dist this package uses.
 *
 * pdfjs ships no types for its legacy build, and declaring the surface here
 * is what lets pdf.ts load it with no type assertions — the repo forbids
 * them, and for good reason: an assertion would silently survive pdfjs
 * changing shape, where this fails the build.
 */
declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export interface PdfTextItem {
    str?: string;
    /** pdfjs's own end-of-line signal — its intended reading-order hint. */
    hasEOL?: boolean;
  }

  export interface PdfPage {
    getTextContent(options?: Record<string, unknown>): Promise<{ items: PdfTextItem[] }>;
  }

  export interface PdfDocument {
    numPages: number;
    getPage(pageNumber: number): Promise<PdfPage>;
  }

  /** Cleanup lives here, not on the document proxy. */
  export interface PdfLoadingTask {
    promise: Promise<PdfDocument>;
    destroy?: () => Promise<void>;
  }

  export function getDocument(parameters: Record<string, unknown>): PdfLoadingTask;
  export const GlobalWorkerOptions: { workerSrc: string };
}
