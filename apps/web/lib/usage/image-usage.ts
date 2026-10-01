/**
 * Reading the image ledger (migration 132) the way the usage pages read
 * the voice ledger: totals over a span in the viewer's zone, org-wide or
 * for one person, and everyone's totals for the leaderboard of who draws
 * the most (by the bytes of the pictures kept, with the tokens the
 * provider billed beside it).
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { inSpan, type UsageSpan } from './user-utilization';
import type { ImageUserRow } from './image-window';

export interface ImageTotals {
  /** Pictures drawn. */
  images: number;
  /** The files as kept. */
  bytes: number;
  /** What the provider billed, where it reports tokens (gpt-image does, FLUX does not). */
  inputTokens: number;
  outputTokens: number;
}

export const ZERO_IMAGE_TOTALS: ImageTotals = {
  images: 0,
  bytes: 0,
  inputTokens: 0,
  outputTokens: 0,
};

interface TotalsRow {
  images: string;
  bytes: string;
  input_tokens: string;
  output_tokens: string;
}

function ownedBy(ownerSubject: string | null) {
  return ownerSubject === null ? sql`` : sql`AND subject = ${ownerSubject}`;
}

export async function getImageTotals(
  db: Kysely<DB>,
  tenantId: string,
  span: UsageSpan,
  timeZone: string,
  ownerSubject: string | null = null
): Promise<ImageTotals> {
  const result = await sql<TotalsRow>`
    SELECT COALESCE(SUM(images), 0) AS images,
           COALESCE(SUM(image_bytes), 0) AS bytes,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens
    FROM image_usage
    WHERE tenant_id = ${tenantId} AND ${inSpan('created_at', span, timeZone)}
      ${ownedBy(ownerSubject)}
  `.execute(db);
  const row = result.rows[0];
  return {
    images: Number(row?.images ?? 0),
    bytes: Number(row?.bytes ?? 0),
    inputTokens: Number(row?.input_tokens ?? 0),
    outputTokens: Number(row?.output_tokens ?? 0),
  };
}

/** Everyone who had an image drawn in the span; unranked. */
export async function getImageUsers(
  db: Kysely<DB>,
  tenantId: string,
  span: UsageSpan,
  timeZone: string
): Promise<ImageUserRow[]> {
  const [usage, identities] = await Promise.all([
    sql<TotalsRow & { subject: string }>`
      SELECT subject,
             COALESCE(SUM(images), 0) AS images,
             COALESCE(SUM(image_bytes), 0) AS bytes,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM image_usage
      WHERE tenant_id = ${tenantId} AND ${inSpan('created_at', span, timeZone)}
      GROUP BY subject
    `.execute(db),
    db
      .selectFrom('identities')
      .select(['subject', 'display_name', 'email'])
      .where('tenant_id', '=', tenantId)
      .execute(),
  ]);
  const identityBySubject = new Map(identities.map((row) => [row.subject, row]));
  return usage.rows.map((row) => {
    const identity = identityBySubject.get(row.subject);
    return {
      subject: row.subject,
      label: identity?.display_name || identity?.email || row.subject,
      images: Number(row.images),
      bytes: Number(row.bytes),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
    };
  });
}
