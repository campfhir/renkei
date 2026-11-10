/**
 * The organization settings form's state (settings-form.tsx): the values
 * as edited, the values as last stored, and where the one Save stands.
 *
 * The component renders the rows and makes the PUT; what the form decides
 * from that — whether Save is allowed, what the request carries (only what
 * changed), what a refusal leaves on screen, what a stored answer does to
 * the fields, how the GB and MB fields map to the bytes stored, what a
 * half-typed size shows — is here, and tested in settings-form.model.test.ts.
 * The server clamps and refuses on its own (app/api/admin/org-settings,
 * route.test.ts beside it).
 */

import { formatByteSize, parseByteSize } from '@/lib/byte-size';

// Mirrors @renkei/settings' LOG_LEVELS — kept local rather than imported so
// the client component never pulls in that package's @renkei/db (pg)
// dependency. The API route is the source of truth for validation.
export const LOG_LEVELS = ['critical', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// Mirrors @renkei/settings' ACT_APPROVAL_POLICIES, kept local for the same
// reason; the labels are this page's words for each value.
export const ACT_APPROVAL_POLICIES = [
  { value: 'externally_triggered', label: 'Runs started by an event or webhook' },
  { value: 'all', label: 'Every run' },
  { value: 'off', label: 'No run (auto-accept is always honored)' },
] as const;
export type ActApprovalPolicy = (typeof ACT_APPROVAL_POLICIES)[number]['value'];

export function isLogLevel(value: string): value is LogLevel {
  return LOG_LEVELS.some((level) => level === value);
}

export function isActApprovalPolicy(value: string): value is ActApprovalPolicy {
  return ACT_APPROVAL_POLICIES.some((policy) => policy.value === value);
}

export interface EditableSettings {
  organizationName: string;
  readOnly: boolean;
  coachMarksEnabled: boolean;
  phiConnectorsRequireCoveredModel: boolean;
  artifactDigestEnabled: boolean;
  enableDcr: boolean;
  sandboxBrowserEnabled: boolean;
  sandboxChartsEnabled: boolean;
  sandboxWorkspacesEnabled: boolean;
  sandboxServicesEnabled: boolean;
  sandboxScriptsEnabled: boolean;
  sandboxScriptsAllowNetwork: boolean;
  logLevel: LogLevel;
  maxJqlResults: number;
  maxAttachmentBytes: number;
  massUploadThreshold: number;
  rateLimitPerUserPerMinute: number;
  accessTokenTtlMinutes: number;
  authorizationCodeTtlSeconds: number;
  refreshTokenTtlDays: number;
  sessionIdleTimeoutMinutes: number;
  agentMaxChainDepth: number;
  agentRunTimeoutMinutes: number;
  agentRunToolCallBudget: number;
  agentMaxRunsPerDay: number;
  agentApprovalMaxWaitDays: number;
  agentActStepsRequireApproval: ActApprovalPolicy;
  contentPollMinutes: number;
  webexWebhookHealthMinutes: number;
  logRetentionDays: number;
  agentNotificationRetentionDays: number;
  agentUsageRetentionDays: number;
  chatRetentionDays: number;
  agentOptimizerWindowDays: number;
  knowledgeKeywordEnrichment: boolean;
  knowledgeKeywordMinChars: number;
  chatReplyPresenceWindowSeconds: number;
  sandboxWorkspaceMaxBytes: number;
  sandboxScriptMemoryBytes: number;
  sandboxServiceMemoryBytes: number;
  sandboxServicePids: number;
  sandboxWorkspacesDebug: boolean;
  admanagerProductName: string;
}

/** The settings that are numbers, for the plain number fields. */
export type NumericSetting = {
  [K in keyof EditableSettings]: EditableSettings[K] extends number ? K : never;
}[keyof EditableSettings];

export type SavePhase = 'idle' | 'saving' | 'saved' | 'error';

export interface SettingsState {
  values: EditableSettings;
  /** What the server last said is stored. */
  saved: EditableSettings;
  phase: SavePhase;
  error: string | null;
}

export type SettingsAction =
  | { type: 'changed'; patch: Partial<EditableSettings> }
  | { type: 'sent' }
  /** The server's answer: what it stored, after its clamps. */
  | { type: 'stored'; settings: EditableSettings }
  | { type: 'failed'; error: string | null };

export function initSettings(initial: EditableSettings): SettingsState {
  return { values: initial, saved: initial, phase: 'idle', error: null };
}

export function settingsReducer(state: SettingsState, action: SettingsAction): SettingsState {
  switch (action.type) {
    case 'changed':
      // An edit after a save takes the "Saved." away; a shown error stays
      // until the next save is sent.
      return { ...state, values: { ...state.values, ...action.patch }, phase: 'idle' };
    case 'sent':
      return { ...state, phase: 'saving', error: null };
    case 'stored':
      // The server clamps; adopting its answer keeps the form honest about
      // what was actually stored.
      return { values: action.settings, saved: action.settings, phase: 'saved', error: null };
    case 'failed':
      return { ...state, phase: 'error', error: action.error ?? 'Save failed' };
  }
}

/** The fields of `after` that differ from `before`. */
export function changedFields<T extends object>(before: T, after: T): Partial<T> {
  const changed: Partial<T> = {};
  for (const key in after) {
    if (after[key] !== before[key]) changed[key] = after[key];
  }
  return changed;
}

/** Whether the form holds anything the server does not. */
export function isDirty(state: SettingsState): boolean {
  return JSON.stringify(state.values) !== JSON.stringify(state.saved);
}

/**
 * What Save sends: only what this form changed. The settings are the whole
 * organization's, and sending every field would write another operator's
 * concurrent save back to what this form last loaded.
 */
export function saveRequest(state: SettingsState): Partial<EditableSettings> {
  return changedFields(state.saved, state.values);
}

export function canSave(state: SettingsState): boolean {
  return state.phase !== 'saving' && isDirty(state);
}

export function saveLabel(state: SettingsState): string {
  return state.phase === 'saving' ? 'Saving…' : 'Save settings';
}

/** "Unsaved changes" beside the button: something to save, and no save in flight. */
export function showsUnsaved(state: SettingsState): boolean {
  return isDirty(state) && state.phase !== 'saving';
}

export const GB = 1_073_741_824;
export const MB = 1_048_576;

/** A byte count as the whole-GB figure its field shows. */
export function toGb(bytes: number): number {
  return Math.round(bytes / GB);
}

/** A whole-MB figure as the byte count stored. */
export function toMb(bytes: number): number {
  return Math.round(bytes / MB);
}

/** What a typed GB or MB figure stores. */
export function gbToBytes(typed: string): number {
  return Number(typed) * GB;
}

export function mbToBytes(typed: string): number {
  return Number(typed) * MB;
}

/**
 * A byte count typed with a unit ("70MB", "2GB") or as bare bytes. While the
 * text is not a size the field keeps the typing, is marked invalid and
 * changes nothing; leaving the field (draft back to null) puts back the
 * last size that parsed.
 */
export function byteSizeField(
  draft: string | null,
  bytes: number
): { text: string; invalid: boolean } {
  return {
    text: draft ?? formatByteSize(bytes),
    invalid: draft !== null && parseByteSize(draft) === null,
  };
}

/** The bytes a keystroke stores, or null when the text is not (yet) a size. */
export function typedBytes(text: string): number | null {
  return parseByteSize(text);
}
