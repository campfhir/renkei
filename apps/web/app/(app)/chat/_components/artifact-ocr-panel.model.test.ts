/**
 * The OCR part of a file's details (artifact-ocr-panel.model.ts), as a
 * person reading the library would describe it. artifacts.spec.ts keeps
 * one real read end to end (asked for, progress drawn, text downloaded,
 * the summary shown) and the share-sheet tap; what the panel says at
 * each step is here.
 */

import type { LibraryItem } from '@/lib/chat/artifact-library';
import {
  alreadyRead,
  canRunOcr,
  durationLabel,
  ocrOffer,
  ocrProgress,
  textFilename,
} from './artifact-ocr-panel.model';

type Run = NonNullable<LibraryItem['ocr']>;

const scan = (more: Partial<LibraryItem> = {}) => ({
  ocrSupported: true,
  ocr: null,
  extractStatus: 'needs_ocr',
  contentType: 'application/pdf',
  filename: 'invoice.pdf',
  ocrPages: null,
  ...more,
});

const run = (more: Partial<Run> = {}, estimate: Partial<Run['estimate']> = {}): Run => ({
  startedAt: '2026-11-01T10:00:00.000Z',
  elapsedMs: 10_000,
  stalled: false,
  estimate: { remainingMs: 20_000, totalMs: 30_000, basedOn: 3, overdue: false, ...estimate },
  ...more,
});

describe('what can be read', () => {
  it('offers OCR on a PDF or picture with no read in flight, and not while one runs', () => {
    expect(canRunOcr(scan())).toBe(true);
    expect(canRunOcr(scan({ ocr: run() }))).toBe(false);
    expect(canRunOcr(scan({ ocrSupported: false }))).toBe(false);
  });

  it('names the downloaded text after the file, without its extension', () => {
    expect(textFilename('scan-share.png')).toBe('scan-share.txt');
    expect(textFilename('notes')).toBe('notes.txt');
    expect(textFilename('.png')).toBe('file.txt');
  });
});

describe('the offer', () => {
  it('a scan not read yet: "Run OCR", explained for a document', () => {
    const offer = ocrOffer(scan());
    expect(offer?.button).toBe('Run OCR');
    expect(offer?.download).toBe(false);
    expect(offer?.pages).toBeNull();
    expect(offer?.explanation).toMatch(/^OCR reads the full text of this file/);
  });

  it('a picture is told its description comes from the picture itself', () => {
    expect(ocrOffer(scan({ contentType: 'image/png' }))?.explanation).toMatch(
      /Its description is written from the picture itself/
    );
  });

  it('after a read: the pages it read, the text to download, and "Read again with OCR"', () => {
    const offer = ocrOffer(scan({ extractStatus: 'done', ocrPages: 2 }));
    expect(alreadyRead({ extractStatus: 'done' })).toBe(true);
    expect(offer).toMatchObject({
      pages: 'Read 2 pages by OCR.',
      download: true,
      button: 'Read again with OCR',
    });
    expect(ocrOffer(scan({ extractStatus: 'done', ocrPages: 1 }))?.pages).toBe(
      'Read 1 page by OCR.'
    );
  });

  it('a failed read offers to try again', () => {
    expect(ocrOffer(scan({ extractStatus: 'ocr_failed' }))?.button).toBe('Try OCR again');
  });

  it('shows nothing for a file OCR cannot read, or while it is being read', () => {
    expect(ocrOffer(scan({ ocrSupported: false }))).toBeNull();
    expect(ocrOffer(scan({ ocr: run() }))).toBeNull();
  });
});

describe('a read in flight', () => {
  it('counts how long it has been and what is left, from the similar files before it', () => {
    const progress = ocrProgress(run(), 2_000);
    expect(progress.sofar).toBe('Reading the scan · 12 s so far');
    expect(progress.estimate).toBe('About 18 s left, from 3 similar files.');
    expect(progress.percent).toBeCloseTo(40);
  });

  it('never fills the bar on the estimate alone, and never counts below zero', () => {
    const late = ocrProgress(run({ elapsedMs: 60_000 }, { remainingMs: 1_000 }), 5_000);
    expect(late.percent).toBe(95);
    expect(late.estimate).toBe('About 0 s left, from 3 similar files.');
  });

  it('says when it is taking longer than the files before it', () => {
    expect(ocrProgress(run({}, { overdue: true, basedOn: 4 }), 0).estimate).toBe(
      'Taking longer than the 4 similar files before it.'
    );
  });

  it('with too few finished reads there is no estimate, and the bar has nothing to measure', () => {
    const progress = ocrProgress(run({}, { remainingMs: null, totalMs: null, basedOn: 1 }), 0);
    expect(progress.percent).toBeNull();
    expect(progress.estimate).toBe(
      'No estimate yet: it needs 3 finished reads of similar files, and there are 1 so far.'
    );
  });

  it('says durations in seconds, then minutes and seconds', () => {
    expect(durationLabel(45_000)).toBe('45 s');
    expect(durationLabel(120_000)).toBe('2 min');
    expect(durationLabel(72_000)).toBe('1 min 12 s');
    expect(durationLabel(-5)).toBe('0 s');
  });
});
