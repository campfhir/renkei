/**
 * @renkei/email-sanitizer — deterministic classify → route →
 * clean/extract/exclude pipeline for email, ahead of embedding. See
 * `pipeline.ts` for the pure orchestration and `service.ts` for the
 * DB-backed entry point connectors call.
 */

export type {
  EmailCategory,
  RawEmail,
  ClassifierMatchType,
  ClassifierRule,
  Classification,
  TemplateSegment,
  ExtractionTemplate,
  TemplateMatch,
  BannerPattern,
  MessageOverrideAction,
  MessageOverride,
  SanitizeResult,
} from './types';

export { classify, type ClassifiableEmail } from './classify';
export { normalizeBody, htmlToText, collapseWhitespace } from './normalize';
export {
  cleanHumanMail,
  truncateQuotedChain,
  truncateSignatureDelimiter,
  stripExternalSenderBanner,
  stripLegalFooter,
  defluffUrls,
} from './clean/generic';
export { deriveTemplate, matchTemplate, type MarkedField } from './registry/template';
export {
  SEED_TEMPLATES,
  JIRA_SEED_SEGMENTS,
  JSM_SEED_SEGMENTS,
  SEED_BANNERS,
  type SeedTemplate,
} from './registry/seed';
export { sanitizeEmail, type SanitizeInputs } from './pipeline';
export { sanitizeEmailForTenant, type SanitizeForTenantOptions } from './service';

export {
  listClassifierRules,
  upsertClassifierRule,
  deleteClassifierRule,
  type ClassifierRuleInput,
} from './persistence/rules';
export {
  listBannerPatterns,
  listActiveBannerPatterns,
  upsertBannerPattern,
  deleteBannerPattern,
  type BannerPatternInput,
} from './persistence/banners';
export {
  listActiveTemplates,
  listTemplateHealth,
  saveTemplateVersion,
  type TemplateHealth,
  type SaveTemplateOptions,
} from './persistence/templates';
export {
  recordClassification,
  hasRecentDuplicate,
  listForOwner,
  countByCategoryForOwner,
  getOwnRow,
  setOverride,
  type ClassificationLogEntry,
  type OwnClassificationRow,
  type ListForOwnerOptions,
  type OwnClassificationPage,
  type CategoryCounts,
  type SetOverrideInput,
} from './persistence/log';
export { hasNearDuplicateChunk, NEAR_DUPLICATE_MAX_DISTANCE } from './persistence/similarity';
