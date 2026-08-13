/**
 * DB accessors for `email_extraction_templates`. These never touch message
 * content — a template's `spec` is boilerplate text plus field names, so
 * this module (and anything built on it, including the admin "template
 * health" view) is safe regardless of who calls it. Deriving a template's
 * `segments` from a real sample happens in `registry/template.ts`, driven
 * by whoever is looking at their own message — this module only persists
 * the result.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { ExtractionTemplate, TemplateSegment } from '../types';

interface TemplateRow {
  id: string;
  sender_key: string;
  version: number;
  status: string;
  spec: unknown;
  match_threshold: number;
}

function isTemplateStatus(value: string): value is ExtractionTemplate['status'] {
  return value === 'active' || value === 'superseded';
}

function toTemplate(row: TemplateRow): ExtractionTemplate {
  return {
    id: row.id,
    senderKey: row.sender_key,
    version: row.version,
    // A row's status only ever comes from saveTemplateVersion's own literal-union
    // input, so this fallback is unreachable in practice.
    status: isTemplateStatus(row.status) ? row.status : 'superseded',
    segments: Array.isArray(row.spec) ? row.spec : [],
    matchThreshold: row.match_threshold,
  };
}

/** Every active template, keyed by senderKey — what the pipeline matches against. */
export async function listActiveTemplates(
  tenantId: string
): Promise<Result<Map<string, ExtractionTemplate>, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const rowsResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('email_extraction_templates')
        .select(['id', 'sender_key', 'version', 'status', 'spec', 'match_threshold'])
        .where('tenant_id', '=', tenantId)
        .where('status', '=', 'active')
        .execute(),
    'DB_ERROR' as const
  );
  if (!rowsResult.ok) return rowsResult;
  return ok(new Map(rowsResult.val.map((row) => [row.sender_key, toTemplate(row)])));
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
  tenantId: string,
  lookbackDays = 7
): Promise<Result<TemplateHealth[], 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  const result = await wrapAsync(async () => {
    const templates = await db
      .selectFrom('email_extraction_templates')
      .select(['sender_key', 'version', 'status', 'match_threshold'])
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'active')
      .execute();

    const counts = await db
      .selectFrom('email_classification_log')
      .select('sender_key')
      .select(({ fn }) => fn.countAll<number>().as('needs_review_count'))
      .where('tenant_id', '=', tenantId)
      .where('needs_review', '=', true)
      .where('sender_key', 'is not', null)
      .where('created_at', '>=', sql<Date>`NOW() - ${lookbackDays} * INTERVAL '1 day'`)
      .groupBy('sender_key')
      .execute();

    const countBySender = new Map(
      counts.map((row) => [row.sender_key, Number(row.needs_review_count)])
    );

    return templates.map((row) => ({
      senderKey: row.sender_key,
      version: row.version,
      status: row.status,
      matchThreshold: row.match_threshold,
      needsReviewCount: countBySender.get(row.sender_key) ?? 0,
    }));
  }, 'DB_ERROR' as const);

  return result;
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
  tenantId: string,
  senderKey: string,
  segments: TemplateSegment[],
  options: SaveTemplateOptions
): Promise<Result<ExtractionTemplate, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  return wrapAsync(async () => {
    const previous = await db
      .selectFrom('email_extraction_templates')
      .select(['id', 'version'])
      .where('tenant_id', '=', tenantId)
      .where('sender_key', '=', senderKey)
      .where('status', '=', 'active')
      .executeTakeFirst();

    if (previous) {
      await db
        .updateTable('email_extraction_templates')
        .set({ status: 'superseded', superseded_at: sql<Date>`NOW()` })
        .where('id', '=', previous.id)
        .execute();
    }

    const id = randomUUID();
    const version = (previous?.version ?? 0) + 1;
    const matchThreshold = options.matchThreshold ?? 0.85;
    await db
      .insertInto('email_extraction_templates')
      .values({
        id,
        tenant_id: tenantId,
        sender_key: senderKey,
        version,
        status: 'active',
        spec: JSON.stringify(segments),
        match_threshold: matchThreshold,
        derived_by_upn: options.derivedByUpn.toLowerCase(),
        // created_at is left to its column default.
      })
      .execute();

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
