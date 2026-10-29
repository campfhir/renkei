/**
 * `email_extraction_templates`, through the data store
 * (`getDataStore().emailSanitizer`). These never touch message
 * content — a template's `spec` is boilerplate text plus field names, so
 * this module (and anything built on it, including the admin "template
 * health" view) is safe regardless of who calls it. Deriving a template's
 * `segments` from a real sample happens in `registry/template.ts`, driven
 * by whoever is looking at their own message — this module only persists
 * the result.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore, type ExtractionTemplateRecord } from '@renkei/db';
import { ok, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { ExtractionTemplate, TemplateSegment } from '../types';

function isTemplateStatus(value: string): value is ExtractionTemplate['status'] {
  return value === 'active' || value === 'superseded';
}

function toTemplate(row: ExtractionTemplateRecord): ExtractionTemplate {
  return {
    id: row.id,
    senderKey: row.senderKey,
    version: row.version,
    // A row's status only ever comes from saveTemplateVersion's own literal-union
    // input, so this fallback is unreachable in practice.
    status: isTemplateStatus(row.status) ? row.status : 'superseded',
    segments: Array.isArray(row.spec) ? row.spec : [],
    matchThreshold: row.matchThreshold,
  };
}

/** Every active template, keyed by senderKey — what the pipeline matches against. */
export async function listActiveTemplates(): Promise<
  Result<Map<string, ExtractionTemplate>, 'DB_ERROR'>
> {
  const rowsResult = await wrapAsync(
    () => getDataStore().emailSanitizer.listActiveTemplates(),
    'DB_ERROR' as const
  );
  if (!rowsResult.ok) return rowsResult;
  return ok(new Map(rowsResult.val.map((row) => [row.senderKey, toTemplate(row)])));
}

export interface TemplateHealth {
  senderKey: string;
  version: number;
  status: string;
  matchThreshold: number;
  /** Count of log rows flagged needs_review for this sender in the lookback window — never content. */
  needsReviewCount: number;
}

/**
 * Content-free summary for the admin "template health" view: sender, active
 * version, status, threshold, and an aggregate drift count. Two independent
 * queries merged in memory — simpler and safer than a conditional join, and
 * neither query ever selects message content.
 */
export async function listTemplateHealth(
  lookbackDays = 7
): Promise<Result<TemplateHealth[], 'DB_ERROR'>> {
  return wrapAsync(async () => {
    const store = getDataStore();
    const templates = await store.emailSanitizer.listActiveTemplates();
    const counts = await store.mailReview.needsReviewCounts(lookbackDays);
    const countBySender = new Map(counts.map((row) => [row.senderKey, row.count]));

    return templates.map((row) => ({
      senderKey: row.senderKey,
      version: row.version,
      status: row.status,
      matchThreshold: row.matchThreshold,
      needsReviewCount: countBySender.get(row.senderKey) ?? 0,
    }));
  }, 'DB_ERROR' as const);
}

export interface SaveTemplateOptions {
  matchThreshold?: number;
  derivedByUpn: string;
}

/**
 * Save a new active version for a sender, superseding whatever was active
 * before it. Superseded versions are kept (audit trail) and never
 * auto-replayed against already-indexed mail.
 */
export async function saveTemplateVersion(
  senderKey: string,
  segments: TemplateSegment[],
  options: SaveTemplateOptions
): Promise<Result<ExtractionTemplate, 'DB_ERROR'>> {
  return wrapAsync(async () => {
    const id = randomUUID();
    const matchThreshold = options.matchThreshold ?? 0.85;
    const version = await getDataStore().emailSanitizer.saveTemplateVersion({
      id,
      senderKey,
      spec: segments,
      matchThreshold,
      derivedByUpn: options.derivedByUpn.toLowerCase(),
    });
    return {
      id,
      senderKey,
      version,
      status: 'active' as const,
      segments,
      matchThreshold,
    };
  }, 'DB_ERROR' as const);
}
