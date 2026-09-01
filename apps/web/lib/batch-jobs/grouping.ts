/**
 * Parsing/validating a document-ocr-pipeline grouping strategy from an
 * untrusted JSON body — shared by the one-off start route and the schedule
 * CRUD routes so the paths cannot drift on what's accepted.
 */

import type { DocumentGrouping } from './start-document-ocr-pipeline';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseGrouping(value: unknown): DocumentGrouping | null {
  if (!isRecord(value)) return null;
  if (value.strategy === 'whole-file') return { strategy: 'whole-file' };
  if (value.strategy === 'filename-pattern') {
    const pattern = value.pattern;
    if (typeof pattern !== 'string' || !pattern) return null;
    if (!pattern.includes('?<documentKey>') || !pattern.includes('?<page>')) return null;
    try {
      new RegExp(pattern);
    } catch {
      return null;
    }
    return { strategy: 'filename-pattern', pattern };
  }
  return null;
}
