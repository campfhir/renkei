/**
 * Org-model-drafted classifier rules, from the evidence the pipeline
 * already collects: rows users CORRECTED on their Mail review page (the
 * classifier was wrong — the strongest signal there is) and rows the
 * classifier flagged as unsure.
 *
 * The model reads message excerpts SERVER-SIDE only. What comes back is
 * rules — sender domains, addresses, subject phrases — which is exactly
 * the vocabulary the admin page already manages; no excerpt, and no other
 * message content, ever reaches the admin UI through this path. Nothing is
 * persisted here either: every suggestion is added (or ignored) by the
 * operator through the ordinary rules API, one deliberate click each.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { resolveAgentLlm } from '@renkei/agent-llm';
import type { ClassifierRule, EmailCategory } from '@renkei/email-sanitizer';
import { isEmailCategory, isClassifierMatchType } from '@/lib/email-sanitizer-guards';
import { logger } from '@/lib/logger';

const SUGGEST_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_TOKENS = 2_048;
const MAX_EXAMPLES = 40;
const MAX_SUGGESTIONS = 6;

export interface RuleSuggestion {
  category: EmailCategory;
  matchType: ClassifierRule['matchType'];
  matchValue: string;
  senderKey: string | null;
  /** One sentence the operator decides from. */
  rationale: string;
}

function promptOf(
  examples: string[],
  existing: { matchType: string; matchValue: string; category: string }[]
): string {
  return [
    'You maintain the sender-policy rules of an email sanitizer. Incoming mail is classified',
    'as one of: human (a person wrote it), system_notification (automated mail from a',
    'system of record — tickets, alerts, receipts), marketing (promotions, newsletters).',
    'Rules match BEFORE anyone reads content, on:',
    '- domain: the From domain equals the value',
    '- sender_domain: the authenticated Sender domain equals the value (catches "on behalf of" relays)',
    '- sender_email: the From address equals the value',
    '- sender_email_contains: the From address contains the value',
    '- reply_to_domain: the Reply-To domain equals the value',
    '- message_id_contains: the Message-ID contains the value (strongest for templated system mail)',
    '- subject_contains: the subject contains the value (use only for very distinctive fixed phrases)',
    '',
    'Below are messages the classifier got wrong (a user corrected it) or was unsure about.',
    'Propose up to ' + String(MAX_SUGGESTIONS) + ' NEW rules that would classify mail like this',
    'correctly in future. Only propose a rule when the evidence clearly supports it — a',
    'pattern visible in the sender or subject, not a guess from one message body. Prefer',
    'sender-based matches over subject phrases. Do not duplicate the existing rules listed.',
    'For system_notification rules include a short snake_case senderKey naming the sending',
    'system family (e.g. "jira", "workday", "sp_notify"); use null otherwise.',
    '',
    'Existing rules (do not repeat):',
    existing.length > 0
      ? existing
          .map((rule) => `- ${rule.matchType} "${rule.matchValue}" → ${rule.category}`)
          .join('\n')
      : '- none yet',
    '',
    'Evidence:',
    ...examples.map((example, index) => `--- Example ${index + 1} ---\n${example}`),
    '',
    'Reply with JSON only, no code fences:',
    '{"rules": [{"category": "human|system_notification|marketing", "matchType": "…", ' +
      '"matchValue": "…", "senderKey": "… or null", "rationale": "one sentence"}]}',
  ].join('\n');
}

export async function suggestSanitizerRules(
  db: Kysely<DB>,
  tenantId: string
): Promise<{ suggestions: RuleSuggestion[] } | { error: string }> {
  const llmResult = await resolveAgentLlm(db, tenantId, null);
  if (!llmResult.ok) {
    return { error: 'No model is configured for this organization.' };
  }
  const llm = llmResult.val;

  // Corrections first (the classifier was WRONG), unsure rows to fill.
  const corrected = await db
    .selectFrom('email_classification_log')
    .select(['excerpt', 'category', 'override_category'])
    .where('tenant_id', '=', tenantId)
    .where('override_category', 'is not', null)
    .orderBy('overridden_at', 'desc')
    .limit(MAX_EXAMPLES)
    .execute();
  const unsure =
    corrected.length < MAX_EXAMPLES
      ? await db
          .selectFrom('email_classification_log')
          .select(['excerpt', 'category'])
          .where('tenant_id', '=', tenantId)
          .where('needs_review', '=', true)
          .where('override_category', 'is', null)
          .orderBy('created_at', 'desc')
          .limit(MAX_EXAMPLES - corrected.length)
          .execute()
      : [];

  if (corrected.length + unsure.length === 0) {
    return {
      error:
        'Nothing to learn from yet — suggestions are drawn from corrections people make on ' +
        'their Mail review page and from messages the classifier was unsure about.',
    };
  }

  const examples = [
    ...corrected.map(
      (row) =>
        `Classified "${row.category}"; the user corrected it to "${row.override_category}".\n${row.excerpt}`
    ),
    ...unsure.map((row) => `Classifier unsure; guessed "${row.category}".\n${row.excerpt}`),
  ];

  const existing = await db
    .selectFrom('email_classifier_rules')
    .select(['match_type', 'match_value', 'category'])
    .where('tenant_id', '=', tenantId)
    .where('enabled', '=', true)
    .execute();
  const existingKeys = new Set(
    existing.map((rule) => `${rule.match_type}:${rule.match_value.toLowerCase()}`)
  );

  const completion = await Promise.race([
    llm.provider.complete({
      system: 'You configure email-classification rules from evidence. You reply with strict JSON.',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: promptOf(
                examples,
                existing.map((rule) => ({
                  matchType: rule.match_type,
                  matchValue: rule.match_value,
                  category: rule.category,
                }))
              ),
            },
          ],
        },
      ],
      tools: [],
      maxTokens: MAX_OUTPUT_TOKENS,
    }),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), SUGGEST_TIMEOUT_MS)),
  ]);
  if (completion === 'timeout') return { error: 'The model took too long — try again.' };
  if (!completion.ok) {
    logger.warn('rule suggestion failed: {kind}', {
      component: 'email-sanitizer/suggest',
      tenantId,
      kind: completion.err.type,
    });
    return { error: 'The model could not draft suggestions — try again later.' };
  }

  const raw = completion.val.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .replace(/```(?:json)?/g, '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { error: 'The model gave an unusable answer.' };

  let parsed: { rules?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { error: 'The model gave an unusable answer.' };
  }
  if (!Array.isArray(parsed.rules)) return { error: 'The model proposed no rules.' };

  const suggestions: RuleSuggestion[] = [];
  for (const entry of parsed.rules.slice(0, MAX_SUGGESTIONS)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const rule: {
      category?: unknown;
      matchType?: unknown;
      matchValue?: unknown;
      senderKey?: unknown;
      rationale?: unknown;
    } = entry;
    if (typeof rule.category !== 'string' || !isEmailCategory(rule.category)) continue;
    if (typeof rule.matchType !== 'string' || !isClassifierMatchType(rule.matchType)) continue;
    if (typeof rule.matchValue !== 'string') continue;
    const matchValue = rule.matchValue.trim().slice(0, 200);
    if (!matchValue) continue;
    if (existingKeys.has(`${rule.matchType}:${matchValue.toLowerCase()}`)) continue;

    const senderKey =
      typeof rule.senderKey === 'string' && rule.senderKey.trim()
        ? rule.senderKey.trim().toLowerCase().replace(/\s+/g, '_').slice(0, 64)
        : null;
    // The rules API requires a senderKey on system_notification; a
    // suggestion that cannot be added as-is is noise.
    if (rule.category === 'system_notification' && !senderKey) continue;

    suggestions.push({
      category: rule.category,
      matchType: rule.matchType,
      matchValue,
      senderKey,
      rationale:
        typeof rule.rationale === 'string' ? rule.rationale.slice(0, 300) : 'No rationale given.',
    });
  }

  if (suggestions.length === 0) {
    return { error: 'The model found no rule it was confident enough to suggest.' };
  }
  return { suggestions };
}
