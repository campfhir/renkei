/**
 * The pure classify → route → clean/extract/exclude orchestration. Pure on
 * purpose: no DB, no network — everything it needs (rules, active templates,
 * an optional owner override) is passed in, so this is independently
 * testable against fixtures and reusable from any connector that produces a
 * `RawEmail`, not just Microsoft's.
 */

import { classify } from './classify';
import { cleanHumanMail } from './clean/generic';
import { normalizeBody } from './normalize';
import { matchTemplate } from './registry/template';
import type {
  ClassifierRule,
  ExtractionTemplate,
  MessageOverride,
  RawEmail,
  SanitizeResult,
} from './types';

export interface SanitizeInputs {
  rules: readonly ClassifierRule[];
  /** Active template keyed by senderKey. */
  templates: ReadonlyMap<string, ExtractionTemplate>;
  raw: RawEmail;
  /** The message owner's explicit correction, when one exists — bypasses automatic routing. */
  override?: MessageOverride;
  /** Literal external-sender-banner phrases to strip; defaults to the built-in seed list when omitted. */
  bannerPatterns?: readonly string[];
}

function headerOf(raw: RawEmail): string {
  return [
    `Subject: ${raw.subject}`,
    `From: ${raw.fromName} <${raw.fromAddress}>`,
    `Received: ${raw.receivedAt}`,
  ].join('\n');
}

function formatExtractedContent(senderKey: string, fields: Record<string, string>): string {
  const lines = [`${senderKey} notification`];
  for (const [name, value] of Object.entries(fields)) {
    if (value) lines.push(`${name}: ${value}`);
  }
  return lines.join('\n');
}

export function sanitizeEmail(inputs: SanitizeInputs): SanitizeResult {
  const bodyText = normalizeBody(inputs.raw.body);
  const header = headerOf(inputs.raw);
  const baseClassification = classify(inputs.rules, inputs.raw);

  if (inputs.override?.action === 'exclude') {
    return {
      action: 'excluded',
      reason: 'override',
      category: baseClassification.category,
      matchedRuleId: baseClassification.matchedRuleId,
      senderKey: baseClassification.senderKey,
      needsReview: false,
    };
  }

  const classification =
    inputs.override?.action === 'reclassify'
      ? {
          category: inputs.override.category ?? 'human',
          matchedRuleId: null,
          senderKey: inputs.override.senderKey ?? null,
        }
      : baseClassification;

  if (classification.category === 'marketing') {
    return {
      action: 'excluded',
      reason: 'marketing',
      category: 'marketing',
      matchedRuleId: classification.matchedRuleId,
      senderKey: null,
      needsReview: false,
    };
  }

  if (classification.category === 'system_notification' && classification.senderKey) {
    const template = inputs.templates.get(classification.senderKey);
    if (template) {
      const match = matchTemplate(template.segments, bodyText);
      if (match.score >= template.matchThreshold) {
        return {
          action: 'index',
          content: `${header}\n\n${formatExtractedContent(classification.senderKey, match.fields)}`,
          category: 'system_notification',
          matchedRuleId: classification.matchedRuleId,
          senderKey: classification.senderKey,
          templateId: template.id,
          templateVersion: template.version,
          matchScore: match.score,
          needsReview: false,
        };
      }
      // Drift: the template no longer matches well. Fail safe to the generic
      // cleaner rather than extracting garbage, and flag for the owner.
      return {
        action: 'index',
        content: `${header}\n\n${cleanHumanMail(bodyText, inputs.bannerPatterns)}`,
        category: 'system_notification',
        matchedRuleId: classification.matchedRuleId,
        senderKey: classification.senderKey,
        templateId: template.id,
        templateVersion: template.version,
        matchScore: match.score,
        needsReview: true,
      };
    }
    // No template yet for this sender: fail safe, flag for the owner to teach one.
    return {
      action: 'index',
      content: `${header}\n\n${cleanHumanMail(bodyText, inputs.bannerPatterns)}`,
      category: 'system_notification',
      matchedRuleId: classification.matchedRuleId,
      senderKey: classification.senderKey,
      templateId: null,
      templateVersion: null,
      matchScore: null,
      needsReview: true,
    };
  }

  return {
    action: 'index',
    content: `${header}\n\n${cleanHumanMail(bodyText, inputs.bannerPatterns)}`,
    category: 'human',
    matchedRuleId: classification.matchedRuleId,
    senderKey: null,
    templateId: null,
    templateVersion: null,
    matchScore: null,
    needsReview: false,
  };
}
