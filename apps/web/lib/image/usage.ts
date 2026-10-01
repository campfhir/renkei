/**
 * Writing the image ledger (migration 132): one row per picture an image
 * generation model drew, after the provider has answered and the file
 * has been validated and kept, attributed to the person who asked.
 * Best-effort, like `recordVoiceUsage`: a ledger row that could not be
 * written is logged and the picture still reaches the person.
 *
 * Content-free by construction — the prompt and the picture never come
 * near this file; only how much.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { logger } from '@/lib/logger';

/** What a tool reports about one picture; the person and org are added by the turn. */
export interface ImageUsageReport {
  /** The wire dialect the model speaks: 'images' or 'flux'. */
  surface: string;
  provider: string;
  model: string;
  /** The file as kept, after validation. */
  imageBytes: number;
  width?: number | null;
  height?: number | null;
  /** Tokens the provider billed, when it said. */
  inputTokens?: number;
  outputTokens?: number;
}

export interface RecordImageUsageInput extends ImageUsageReport {
  tenantId: string;
  subject: string;
}

export async function recordImageUsage(
  db: Kysely<DB>,
  input: RecordImageUsageInput
): Promise<void> {
  try {
    await db
      .insertInto('image_usage')
      .values({
        tenant_id: input.tenantId,
        subject: input.subject,
        surface: input.surface.slice(0, 16),
        provider: input.provider.slice(0, 32),
        model: input.model.slice(0, 120),
        images: 1,
        image_bytes: Math.max(0, Math.round(input.imageBytes)),
        width: input.width ?? null,
        height: input.height ?? null,
        input_tokens: Math.max(0, Math.round(input.inputTokens ?? 0)),
        output_tokens: Math.max(0, Math.round(input.outputTokens ?? 0)),
      })
      .execute();
  } catch (error) {
    logger.warn('image usage not recorded for tenant {tenantId}', {
      component: 'web/image-usage',
      tenantId: input.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
