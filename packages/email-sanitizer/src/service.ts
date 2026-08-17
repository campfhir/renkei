/**
 * The DB-touching entry point: load a tenant's rules and active templates,
 * run the pure pipeline, apply exact-hash dedup (and, when an embedder is
 * supplied, near-duplicate dedup via embedding cosine similarity), and
 * record the classification log row. Everything DB-shaped lives here so
 * `pipeline.ts` stays a pure function fixtures can exercise directly.
 */

import { createHash } from 'node:crypto';
import { vectorLiteral } from '@renkei/knowledge';
import type { EmbeddingProvider } from '@renkei/knowledge';
import { sanitizeEmail } from './pipeline';
import { listClassifierRules } from './persistence/rules';
import { listActiveTemplates } from './persistence/templates';
import { listActiveBannerPatterns } from './persistence/banners';
import { hasRecentDuplicate, recordClassification } from './persistence/log';
import { hasNearDuplicateChunk } from './persistence/similarity';
import { listActiveCleanerScripts, recordCleanerScriptError } from './persistence/scripts';
import { runCleanerScript } from './scripts/run';
import { SEED_BANNERS } from './registry/seed';
import type { MessageOverride, RawEmail, SanitizeResult } from './types';

/** How long an exact duplicate of a cleaned message is remembered before re-indexing is allowed again. */
const DUPLICATE_LOOKBACK_DAYS = 30;

function hashContent(content: string): string {
  return createHash('sha256')
    .update(content.replace(/\s+/g, ' ').trim().toLowerCase())
    .digest('hex');
}

function excerptOf(raw: RawEmail): string {
  const snippet = raw.body.content
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
  return `Subject: ${raw.subject}\nFrom: ${raw.fromName} <${raw.fromAddress}>\n\n${snippet}`.slice(
    0,
    1000
  );
}

export interface SanitizeForTenantOptions {
  tenantId: string;
  provider: string;
  refId: string;
  /** The mailbox owner's identity — the only scope any later read of this message's log row will use. */
  ownerUpn: string;
  /** The connector account/grant id for this owner, when the connector has one — lets an override re-resolve access later without a reverse lookup by identity. */
  accountId?: string | null;
  raw: RawEmail;
  override?: MessageOverride;
  /**
   * When supplied, an extra near-duplicate check runs via embedding cosine
   * similarity after the exact-hash check passes — catches recurring
   * automated notifications that repeat almost verbatim but are never
   * byte-identical (a timestamp or a name differs). Omit to keep exact-hash
   * dedup only; a failed embed call degrades to that same behavior.
   */
  embedder?: EmbeddingProvider;
}

/**
 * Run the tenant's enabled cleaner scripts over an index-bound content
 * string. The header (Subject/From/Received, the first paragraph) is held
 * back — scripts transform the message body, not the metadata the index
 * relies on. Script failures are recorded on the script's own row and the
 * text passes through unchanged; a broken script is a visible no-op, never
 * a lost message.
 */
async function applyCleanerScripts(
  options: SanitizeForTenantOptions,
  content: string
): Promise<string> {
  const scriptsResult = await listActiveCleanerScripts(options.tenantId);
  if (!scriptsResult.ok || scriptsResult.val.length === 0) return content;

  const separator = content.indexOf('\n\n');
  const header = separator >= 0 ? content.slice(0, separator) : '';
  let body = separator >= 0 ? content.slice(separator + 2) : content;

  for (const script of scriptsResult.val) {
    const run = await runCleanerScript(script.script, {
      text: body,
      subject: options.raw.subject,
      fromAddress: options.raw.fromAddress,
      fromName: options.raw.fromName,
    });
    if (run.ok) {
      body = run.val;
      if (script.lastError) await recordCleanerScriptError(options.tenantId, script.id, null);
    } else {
      await recordCleanerScriptError(
        options.tenantId,
        script.id,
        `${run.err.type}: ${run.detail ?? ''}`.trim()
      );
    }
  }
  return header ? `${header}\n\n${body}` : body;
}

/**
 * The ref-id namespace a message dedupes within — everything up to its last
 * path segment, so 'alice@x.com/msg/AAA' compares only against that
 * mailbox's other mail. Derived rather than hardcoded so the shape stays
 * whatever the connector's refId builder decides.
 */
function namespaceOf(refId: string): string {
  const lastSlash = refId.lastIndexOf('/');
  return lastSlash > 0 ? refId.slice(0, lastSlash + 1) : refId;
}

function excludedAsDuplicate(result: Extract<SanitizeResult, { action: 'index' }>): SanitizeResult {
  return {
    action: 'excluded',
    reason: 'duplicate',
    category: result.category,
    matchedRuleId: result.matchedRuleId,
    senderKey: result.senderKey,
    needsReview: false,
  };
}

/**
 * The pure pipeline's result plus, when the near-duplicate check ran and the
 * message is still being indexed, the vector that check computed — the
 * content it embeds is exactly what gets ingested, so callers can reuse it
 * instead of paying for a second identical embedding call.
 */
export type TenantSanitizeResult = SanitizeResult & { embedding?: number[] };

export async function sanitizeEmailForTenant(
  options: SanitizeForTenantOptions
): Promise<TenantSanitizeResult> {
  const [rulesResult, templatesResult, bannersResult] = await Promise.all([
    listClassifierRules(options.tenantId),
    listActiveTemplates(options.tenantId),
    listActiveBannerPatterns(options.tenantId),
  ]);
  const rules = rulesResult.ok ? rulesResult.val : [];
  const templates = templatesResult.ok ? templatesResult.val : new Map();
  // The built-in defaults always apply; a tenant's own library only adds to
  // them, so out-of-the-box stripping never regresses to "nothing stripped"
  // while an org is still building out its list.
  const bannerPatterns = [...SEED_BANNERS, ...(bannersResult.ok ? bannersResult.val : [])];

  let result: TenantSanitizeResult = sanitizeEmail({
    rules,
    templates,
    raw: options.raw,
    override: options.override,
    bannerPatterns,
  });

  // Tenant cleaner scripts run over the cleaned BODY (never the header),
  // BEFORE hashing — dedup must see the content that will be indexed. Every
  // failure is a recorded no-op: a broken script never eats a message.
  if (result.action === 'index') {
    result = { ...result, content: await applyCleanerScripts(options, result.content) };
  }

  let contentHash: string | null = null;
  if (result.action === 'index') {
    contentHash = hashContent(result.content);
    const dupResult = await hasRecentDuplicate(
      options.tenantId,
      contentHash,
      DUPLICATE_LOOKBACK_DAYS,
      { ownerUpn: options.ownerUpn, refId: options.refId }
    );
    if (dupResult.ok && dupResult.val) {
      result = excludedAsDuplicate(result);
    } else if (options.embedder) {
      // Not byte-identical to anything recent — check whether it's a
      // near-duplicate (a recurring notification that varies only in a
      // timestamp/name) before paying to index it as if it were new.
      const embedded = await options.embedder.embed([result.content]);
      if (embedded.ok && embedded.val[0]) {
        const nearDupResult = await hasNearDuplicateChunk(
          options.tenantId,
          vectorLiteral(embedded.val[0]),
          { refId: options.refId, refIdPrefix: namespaceOf(options.refId) }
        );
        if (nearDupResult.ok && nearDupResult.val) {
          result = excludedAsDuplicate(result);
        } else {
          result = { ...result, embedding: embedded.val[0] };
        }
      }
    }
  }

  await recordClassification({
    tenantId: options.tenantId,
    provider: options.provider,
    refId: options.refId,
    ownerUpn: options.ownerUpn,
    accountId: options.accountId ?? null,
    result,
    contentHash,
    excerpt: excerptOf(options.raw),
  });

  return result;
}
