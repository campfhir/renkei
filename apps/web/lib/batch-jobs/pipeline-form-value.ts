/**
 * The form-side shape of document-ocr-pipeline's optional behaviours, and
 * the conversions to and from what a batch or schedule stores. Pure and
 * import-safe from both a server page (unpacking a stored config for the
 * edit form) and the client forms (packing the request body), which is
 * why it lives here rather than beside the 'use client' field component.
 */

import type { AfterProcessing } from './start-document-ocr-pipeline';

export type AfterProcessingAction = 'keep' | 'move' | 'delete';

/**
 * Flat on purpose: a form keeps the move target around while the radio
 * says "keep", so switching back and forth does not lose a picked folder.
 */
export interface AfterProcessingValue {
  action: AfterProcessingAction;
  /** The destination share for a move; '' means "the source share". */
  shareId: string;
  path: string;
}

export const KEEP_AFTER_PROCESSING: AfterProcessingValue = {
  action: 'keep',
  shareId: '',
  path: '/',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Stored config → form value; anything unrecognised reads as keep. */
export function afterProcessingValueOf(config: Record<string, unknown>): AfterProcessingValue {
  const raw = isRecord(config.afterProcessing) ? config.afterProcessing : {};
  const action = str(raw.action);
  if (action === 'delete') return { action: 'delete', shareId: '', path: '/' };
  if (action === 'move')
    return { action: 'move', shareId: str(raw.shareId), path: str(raw.path) || '/' };
  return KEEP_AFTER_PROCESSING;
}

/** Stored config → "skip files already processed"; absent means on. */
export function skipProcessedOf(config: Record<string, unknown>): boolean {
  return config.skipProcessed !== false;
}

/** Form value → the request body's `afterProcessing`. */
export function afterProcessingPayload(
  value: AfterProcessingValue,
  sourceShareId: string
): AfterProcessing {
  if (value.action === 'delete') return { action: 'delete' };
  if (value.action === 'move') {
    return {
      action: 'move',
      shareId: value.shareId || sourceShareId,
      path: value.path.trim() || '/',
    };
  }
  return { action: 'keep' };
}
