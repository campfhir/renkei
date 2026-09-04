/**
 * @renkei/settings — platform and org configuration from the database.
 *
 * The principle (RENKEI.md Decision #19): the environment holds only what is
 * needed before the database can answer — the connection, the root
 * encryption key, process wiring. Everything else is policy, and policy is
 * data: deployment-scoped values in `platform_settings`, org-scoped policy
 * in `tenant_settings`, both read here through typed accessors with explicit
 * defaults and a short cache.
 */

import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

/** Org-scoped policy (Decision #13: org-admins set defaults and limits). */
export interface OrgSettings {
  /** Org-wide read-only mode: no mutating capability is exposed. */
  readOnly: boolean;
  /**
   * Connector keys switched off org-wide — their tools stop being registered
   * for every user, immediately and without touching anyone's grant.
   *
   * Deliberately separate from the connector's `enabled` flag and from the
   * scope ceiling. Disabling a connector_config stops new CONNECTIONS and
   * narrowing the ceiling forces everyone to reconnect to get a capability
   * back; this only hides tools, so flipping it back on restores them with
   * no user action at all. That makes it the right control for "turn this
   * off for now".
   */
  disabledConnectors: string[];
  /** RFC 7591 dynamic client registration on this org's OAuth server. */
  enableDcr: boolean;
  maxJqlResults: number;
  maxAttachmentBytes: number;
  rateLimitPerUserPerMinute: number;
  accessTokenTtlMinutes: number;
  authorizationCodeTtlSeconds: number;
  refreshTokenTtlDays: number;
  /**
   * Best-effort removal of identifiers from MCP tool results before they reach
   * a model (@renkei/redaction). On by default: the shipped detectors are
   * precise enough to run untuned, and a protection nobody switches on
   * protects nobody.
   */
  redactionEnabled: boolean;
  /**
   * Which detectors run. Patient names and phone numbers are absent from the
   * default on purpose — names because the marker vocabulary varies by org,
   * phone because signature blocks are full of them.
   */
  redactionDetectors: string[];
  /**
   * Extra medical-record-number shapes, in the redaction package's pattern
   * language (`MR-#######`), NOT regular expressions — admin-supplied regex
   * runs in a shared process and can be made to backtrack for minutes. There
   * is no universal MRN format, so a site has to say what its own look like.
   */
  redactionMrnFormats: string[];
  /**
   * How long agent run records (agent_runs + their step attempts) are kept
   * before the retention sweep prunes them. Run detail includes content —
   * tool call previews, resolved instructions — so retention is an org
   * policy, not a platform constant.
   */
  agentRunRetentionDays: number;
  /**
   * How long an agent's notifications are kept before the sweep prunes
   * them. The ceiling on what a person can choose to keep, not a per-user
   * setting: notifications name what an employee's automations did and to
   * what, so how long that record lives is the org's call, the same reason
   * `agentRunRetentionDays` is here.
   *
   * There is no "keep forever" value on purpose. This feed is high-volume
   * ambient record, not the audit trail — that is `audit_events` and the
   * card archive, both of which are kept.
   */
  agentNotificationRetentionDays: number;
  /**
   * How long the usage ledgers are kept: the per-run log (agent_run_log —
   * status, timing, cost; on failure the step, the kind, a clipped
   * message) and the per-call token ledger (llm_calls). Longer than run
   * retention on purpose: they exist so a year of usage, and "which step
   * has this agent been failing on all quarter", stay answerable after
   * the runs themselves are pruned. Content-light (never arguments,
   * results, or transcripts), but still an org policy.
   */
  agentUsageRetentionDays: number;
  /**
   * Days to keep a chat (its messages and attachments) after its last
   * activity; 0 keeps everything. Enforced by the agents worker's sweep.
   */
  chatRetentionDays: number;
  /**
   * How far back the agent optimizer looks when it gathers evidence —
   * captured failures, per-step token spend, recent failed runs. Wider
   * sees more history; narrower reflects the agent as it is now after an
   * edit. The failed-run samples it reads are bounded by run retention
   * regardless.
   */
  agentOptimizerWindowDays: number;
  /**
   * How deep an agent-triggers-agent chain may go. The queue's attempt
   * budget bounds retries, not fan-out; this is the fan-out bound.
   */
  agentMaxChainDepth: number;
  /** Wall-clock budget for a single agent run, checked between attempts. */
  agentRunTimeoutMinutes: number;
  /**
   * Org ceiling on a step's total attempts ("give up after N tries").
   * Default 10 — a deliberate limit, not a hard one: an org may raise it
   * (the admin API bounds it at 100 so a typo cannot mint a thousand-try
   * loop) or lower it. Enforced by the engine at runtime, so a change takes
   * effect on existing agents without re-saving them.
   */
  agentMaxStepAttempts: number;
  /**
   * Org ceiling on how many steps one agent may hold. Default 20 — the
   * value that used to be the hardcoded MAX_STEPS — and, like the attempt
   * ceiling, a policy rather than a platform constant: an org may raise it
   * (the admin API bounds it at 100) or lower it. Enforced at save time;
   * an already-saved agent over a lowered ceiling keeps running until its
   * next edit, because refusing to RUN what was legal to save would stop
   * automations with nobody at the keyboard.
   */
  agentMaxSteps: number;
  /** Per-tenant ceiling on runs started per day — the runaway-trigger brake. */
  agentMaxRunsPerDay: number;
  /**
   * Hard upper bound on how long an approval node may wait for the owner
   * to act before its timeout path routes. Nodes declare their own wait in
   * hours; this org ceiling clamps them — at save AND live at pause time,
   * so lowering it bites existing agents without a re-save.
   */
  agentApprovalMaxWaitDays: number;
  /**
   * How stale watched content (Jira projects, Confluence spaces, document
   * libraries) may get before the worker polls it again. Atlassian offers
   * plain OAuth apps no push, so this dial IS that content's freshness —
   * and its provider-API bill. The worker's sweep wakes every 5 minutes, so
   * values below 5 cannot poll any faster.
   */
  contentPollMinutes: number;
  /**
   * How often the worker re-checks each opted-in WebEx grant's webhook
   * registration (repair, not sync — WebEx pushes events; this only notices
   * when WebEx has quietly dropped or deactivated the registration). Unlike
   * content polling this is pure overhead when nothing has rotted: every
   * check is one `/webhooks` call per opted-in grant, so a tenant with many
   * opted-in users can trip WebEx's per-app rate limit at a short interval.
   * The worker's sweep wakes every 15 minutes, so values below 15 cannot
   * check any faster.
   */
  webexWebhookHealthMinutes: number;
  /**
   * How long bored-logs rows are kept before the retention sweep purges
   * them. 0 = keep forever (the default — deleting observability data is an
   * explicit choice). The logs table is deployment-wide, so with several
   * tenants the sweep honors the LONGEST retention any tenant asks for and
   * purges nothing while any tenant keeps the default.
   */
  logRetentionDays: number;
  /**
   * Whether the knowledge index asks the org's default LLM model for
   * search keywords when it ingests an item (packages/knowledge/src/
   * keywords.ts). Off by default: it is one model call per indexed item,
   * which for a mailbox backfill is the dominant cost of ingestion, so an
   * org opts in knowing that.
   */
  knowledgeKeywordEnrichment: boolean;
  /**
   * Items shorter than this many characters are not sent for keyword
   * extraction. A one-line chat message or a two-sentence mail has nothing
   * a model can add over its own words, and skipping it is the difference
   * between paying per document and paying per message.
   */
  knowledgeKeywordMinChars: number;
}

/** The defaults formerly hardcoded in the environment schema. */
export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  readOnly: false,
  disabledConnectors: [],
  enableDcr: true,
  maxJqlResults: 100,
  maxAttachmentBytes: 20_971_520, // 20MB
  rateLimitPerUserPerMinute: 60,
  accessTokenTtlMinutes: 60,
  authorizationCodeTtlSeconds: 60,
  refreshTokenTtlDays: 30,
  redactionEnabled: true,
  redactionDetectors: ['ssn', 'card', 'mrn', 'dob'],
  redactionMrnFormats: [],
  agentRunRetentionDays: 30,
  agentNotificationRetentionDays: 14,
  agentUsageRetentionDays: 365,
  chatRetentionDays: 0,
  agentOptimizerWindowDays: 30,
  agentMaxChainDepth: 3,
  agentRunTimeoutMinutes: 15,
  agentMaxStepAttempts: 10,
  agentMaxSteps: 20,
  agentMaxRunsPerDay: 200,
  agentApprovalMaxWaitDays: 14,
  contentPollMinutes: 15,
  // Above the worker's 15-minute sweep floor: the previous fixed 15-minute
  // cadence was tripping WebEx's rate limit on orgs with many opted-in
  // users, one `/webhooks` call per grant every pass.
  webexWebhookHealthMinutes: 60,
  logRetentionDays: 0,
  knowledgeKeywordEnrichment: false,
  knowledgeKeywordMinChars: 500,
};

const CACHE_TTL_MS = 60_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const orgCache = new Map<string, CacheEntry<OrgSettings>>();

function coerce(current: unknown, fallback: boolean | number): boolean | number {
  if (typeof fallback === 'boolean') return typeof current === 'boolean' ? current : fallback;
  return typeof current === 'number' && Number.isFinite(current) ? current : fallback;
}

/** The first non-scalar setting, so it needs its own guard rather than coerce. */
function coerceStringList(current: unknown, fallback: string[]): string[] {
  if (!Array.isArray(current)) return fallback;
  return current.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * The org's settings, defaults filled in for anything unset. Cached briefly;
 * a change takes effect within the TTL (or immediately after a setter, which
 * invalidates).
 */
export async function getOrgSettings(tenantId: string): Promise<Result<OrgSettings, 'DB_ERROR'>> {
  const cached = orgCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return ok(cached.value);

  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const rowsResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('tenant_settings')
        .select(['key', 'value'])
        .where('tenant_id', '=', tenantId)
        .execute(),
    'DB_ERROR' as const
  );
  if (!rowsResult.ok) return rowsResult;

  const stored = new Map(rowsResult.val.map((row) => [row.key, row.value]));
  const d = DEFAULT_ORG_SETTINGS;
  const settings: OrgSettings = {
    readOnly: Boolean(coerce(stored.get('read_only'), d.readOnly)),
    disabledConnectors: coerceStringList(stored.get('disabled_connectors'), d.disabledConnectors),
    enableDcr: Boolean(coerce(stored.get('enable_dcr'), d.enableDcr)),
    maxJqlResults: Number(coerce(stored.get('max_jql_results'), d.maxJqlResults)),
    maxAttachmentBytes: Number(coerce(stored.get('max_attachment_bytes'), d.maxAttachmentBytes)),
    rateLimitPerUserPerMinute: Number(
      coerce(stored.get('rate_limit_per_user_per_minute'), d.rateLimitPerUserPerMinute)
    ),
    accessTokenTtlMinutes: Number(
      coerce(stored.get('access_token_ttl_minutes'), d.accessTokenTtlMinutes)
    ),
    authorizationCodeTtlSeconds: Number(
      coerce(stored.get('authorization_code_ttl_seconds'), d.authorizationCodeTtlSeconds)
    ),
    refreshTokenTtlDays: Number(
      coerce(stored.get('refresh_token_ttl_days'), d.refreshTokenTtlDays)
    ),
    redactionEnabled: Boolean(coerce(stored.get('redaction_enabled'), d.redactionEnabled)),
    redactionDetectors: coerceStringList(stored.get('redaction_detectors'), d.redactionDetectors),
    // A new key rather than a reused one: the old `redaction_mrn_patterns`
    // held regular expressions, and silently reinterpreting those as patterns
    // in a different language would change what they match.
    redactionMrnFormats: coerceStringList(
      stored.get('redaction_mrn_formats'),
      d.redactionMrnFormats
    ),
    agentNotificationRetentionDays: Number(
      coerce(stored.get('agent_notification_retention_days'), d.agentNotificationRetentionDays)
    ),
    agentRunRetentionDays: Number(
      coerce(stored.get('agent_run_retention_days'), d.agentRunRetentionDays)
    ),
    agentUsageRetentionDays: Number(
      coerce(stored.get('agent_usage_retention_days'), d.agentUsageRetentionDays)
    ),
    chatRetentionDays: Number(coerce(stored.get('chat_retention_days'), d.chatRetentionDays)),
    agentOptimizerWindowDays: Number(
      coerce(stored.get('agent_optimizer_window_days'), d.agentOptimizerWindowDays)
    ),
    agentMaxChainDepth: Number(coerce(stored.get('agent_max_chain_depth'), d.agentMaxChainDepth)),
    agentRunTimeoutMinutes: Number(
      coerce(stored.get('agent_run_timeout_minutes'), d.agentRunTimeoutMinutes)
    ),
    agentMaxStepAttempts: Number(
      coerce(stored.get('agent_max_step_attempts'), d.agentMaxStepAttempts)
    ),
    agentMaxSteps: Number(coerce(stored.get('agent_max_steps'), d.agentMaxSteps)),
    agentMaxRunsPerDay: Number(coerce(stored.get('agent_max_runs_per_day'), d.agentMaxRunsPerDay)),
    agentApprovalMaxWaitDays: Number(
      coerce(stored.get('agent_approval_max_wait_days'), d.agentApprovalMaxWaitDays)
    ),
    contentPollMinutes: Number(coerce(stored.get('content_poll_minutes'), d.contentPollMinutes)),
    webexWebhookHealthMinutes: Number(
      coerce(stored.get('webex_webhook_health_minutes'), d.webexWebhookHealthMinutes)
    ),
    logRetentionDays: Number(coerce(stored.get('log_retention_days'), d.logRetentionDays)),
    knowledgeKeywordEnrichment: Boolean(
      coerce(stored.get('knowledge_keyword_enrichment'), d.knowledgeKeywordEnrichment)
    ),
    knowledgeKeywordMinChars: Number(
      coerce(stored.get('knowledge_keyword_min_chars'), d.knowledgeKeywordMinChars)
    ),
  };

  orgCache.set(tenantId, { value: settings, expiresAt: Date.now() + CACHE_TTL_MS });
  return ok(settings);
}

/** Upsert a subset of org settings; unspecified fields keep their value. */
export async function setOrgSettings(
  tenantId: string,
  updates: Partial<OrgSettings>
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  const pairs: Array<[string, boolean | number | string[] | undefined]> = [
    ['read_only', updates.readOnly],
    ['disabled_connectors', updates.disabledConnectors],
    ['enable_dcr', updates.enableDcr],
    ['max_jql_results', updates.maxJqlResults],
    ['max_attachment_bytes', updates.maxAttachmentBytes],
    ['rate_limit_per_user_per_minute', updates.rateLimitPerUserPerMinute],
    ['access_token_ttl_minutes', updates.accessTokenTtlMinutes],
    ['authorization_code_ttl_seconds', updates.authorizationCodeTtlSeconds],
    ['refresh_token_ttl_days', updates.refreshTokenTtlDays],
    ['redaction_enabled', updates.redactionEnabled],
    ['redaction_detectors', updates.redactionDetectors],
    ['redaction_mrn_formats', updates.redactionMrnFormats],
    ['agent_run_retention_days', updates.agentRunRetentionDays],
    ['agent_notification_retention_days', updates.agentNotificationRetentionDays],
    ['agent_usage_retention_days', updates.agentUsageRetentionDays],
    ['chat_retention_days', updates.chatRetentionDays],
    ['agent_optimizer_window_days', updates.agentOptimizerWindowDays],
    ['agent_max_chain_depth', updates.agentMaxChainDepth],
    ['agent_run_timeout_minutes', updates.agentRunTimeoutMinutes],
    ['agent_max_step_attempts', updates.agentMaxStepAttempts],
    ['agent_max_steps', updates.agentMaxSteps],
    ['agent_max_runs_per_day', updates.agentMaxRunsPerDay],
    ['agent_approval_max_wait_days', updates.agentApprovalMaxWaitDays],
    ['content_poll_minutes', updates.contentPollMinutes],
    ['webex_webhook_health_minutes', updates.webexWebhookHealthMinutes],
    ['log_retention_days', updates.logRetentionDays],
    ['knowledge_keyword_enrichment', updates.knowledgeKeywordEnrichment],
    ['knowledge_keyword_min_chars', updates.knowledgeKeywordMinChars],
  ];

  for (const [key, value] of pairs) {
    if (value === undefined) continue;
    const result = await wrapAsync(
      () =>
        db
          .insertInto('tenant_settings')
          .values({
            tenant_id: tenantId,
            key,
            value: JSON.stringify(value),
            updated_at: new Date().toISOString(),
          })
          .onConflict((oc) =>
            oc.columns(['tenant_id', 'key']).doUpdateSet({
              value: JSON.stringify(value),
              updated_at: new Date().toISOString(),
            })
          )
          .execute(),
      'DB_ERROR' as const
    );
    if (!result.ok) return result;
  }

  orgCache.delete(tenantId);
  return ok();
}

/**
 * The deployment's public base URL from PUBLIC_BASE_URL, or null when unset —
 * web callers then fall back to trusted proxy headers and finally the request
 * URL (see web's getOrigin).
 *
 * Deliberately NOT a platform_settings row, and an exception to Decision #19's
 * policy-is-data rule: this value gates the OIDC redirect_uri, so it must be
 * correct before anyone can authenticate — a setting only reachable behind
 * sign-in cannot configure sign-in. It previously lived in the database, which
 * meant hand-seeding by SQL and silent reversion to localhost whenever the
 * database was rebuilt.
 */
export function getPublicBaseUrl(): string | null {
  const fromEnv = process.env.PUBLIC_BASE_URL?.trim();
  return fromEnv ? fromEnv.replace(/\/+$/, '') : null;
}

/** Test hook. */
export function invalidateSettingsCache(): void {
  orgCache.clear();
}
