/**
 * An OAuth app registration form with a scope ceiling — the five Atlassian
 * apps (atlassian-forms.tsx) and Entra Developer (entra-developer-form.tsx)
 * — with no network or React: the fields as the stored registration fills
 * them, which capability boxes start ticked, what Save sends (a blank
 * secret keeps the stored one; the always-on scopes ride on every save),
 * how the secret fields read once a secret is stored, and what a save
 * leaves on screen. Tested in app-registration-form.model.test.ts.
 */

import { optionWithin, scopesOfOptions, type ScopeOption } from '@/lib/scope-catalog';

/** What GET /api/admin/connectors/<connector> answers, as far as these forms read it. */
export interface AppRegistrationConfig {
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  scopes: string | null;
  hasClientSecret: boolean;
  /** Atlassian apps: an override of the OAuth callback. */
  redirectUri?: string | null;
  /** Entra Developer: the directory the app authorizes against. */
  directoryTenantId?: string | null;
  /** Bitbucket: whether a webhook shared secret is stored. */
  hasWebhookSecret?: boolean;
}

/** What a form is for: its scope catalog, and the extra fields it carries. */
export interface AppRegistrationSpec {
  options: readonly ScopeOption[];
  /** Scopes added to every save, never offered as a box (offline_access, `account`, openid…). */
  alwaysScopes: readonly string[];
  /** Entra Developer: a required Directory (tenant) ID. */
  directory?: boolean;
  /** Atlassian: an optional redirect URI override. */
  redirectUri?: boolean;
  /** Bitbucket: an optional webhook shared secret. */
  webhookSecret?: boolean;
}

export interface AppRegistrationFields {
  clientId: string;
  clientSecret: string;
  directoryTenantId: string;
  redirectUri: string;
  webhookSecret: string;
  enabled: boolean;
  /** The ticked capability boxes, by option id. */
  checkedIds: ReadonlySet<string>;
}

export interface AppRegistrationState {
  fields: AppRegistrationFields;
  busy: boolean;
  notice: string | null;
  error: string | null;
}

export type AppRegistrationAction =
  /** The stored registration arrived (or arrived again after a save). */
  | { type: 'loaded'; config: AppRegistrationConfig }
  | {
      type: 'edit';
      patch: Partial<Omit<AppRegistrationFields, 'checkedIds'>>;
    }
  | { type: 'toggle'; optionId: string; on: boolean }
  | { type: 'saving' }
  | { type: 'saved' }
  | { type: 'save-failed'; error: string };

/** A form never saved: every box its catalog ticks by default, and on. */
export function initialAppRegistration(spec: AppRegistrationSpec): AppRegistrationState {
  return {
    fields: {
      clientId: '',
      clientSecret: '',
      directoryTenantId: '',
      redirectUri: '',
      webhookSecret: '',
      enabled: true,
      checkedIds: new Set(
        spec.options.filter((option) => option.defaultChecked).map((option) => option.id)
      ),
    },
    busy: false,
    notice: null,
    error: null,
  };
}

/**
 * The boxes a stored ceiling ticks: an option is ticked when the ceiling
 * covers its whole bundle. A ceiling that matches no option (one saved
 * before the granular migration) leaves the current boxes as they are, so
 * re-saving lands on sane scopes.
 */
export function checkedFromCeiling(
  options: readonly ScopeOption[],
  scopes: string | null,
  current: ReadonlySet<string>
): ReadonlySet<string> {
  if (!scopes) return current;
  const stored = new Set(scopes.split(/\s+/));
  const matching = options.filter((option) => optionWithin(option, stored));
  return matching.length > 0 ? new Set(matching.map((option) => option.id)) : current;
}

export function appRegistrationReducer(
  spec: AppRegistrationSpec
): (state: AppRegistrationState, action: AppRegistrationAction) => AppRegistrationState {
  return (state, action) => {
    switch (action.type) {
      case 'loaded': {
        const { config } = action;
        return {
          ...state,
          fields: {
            ...state.fields,
            clientId: config.clientId ?? '',
            directoryTenantId: config.directoryTenantId ?? '',
            redirectUri: config.redirectUri ?? '',
            checkedIds: config.configured
              ? checkedFromCeiling(spec.options, config.scopes, state.fields.checkedIds)
              : state.fields.checkedIds,
            // A registration never saved starts enabled: saving it is turning it on.
            enabled: config.configured ? config.enabled : true,
          },
        };
      }
      case 'edit':
        return { ...state, fields: { ...state.fields, ...action.patch } };
      case 'toggle': {
        const checkedIds = new Set(state.fields.checkedIds);
        if (action.on) checkedIds.add(action.optionId);
        else checkedIds.delete(action.optionId);
        return { ...state, fields: { ...state.fields, checkedIds } };
      }
      case 'saving':
        return { ...state, busy: true, notice: null, error: null };
      case 'saved':
        // The secrets typed are stored now; the fields go blank, meaning "keep".
        return {
          ...state,
          busy: false,
          notice: 'Saved',
          fields: { ...state.fields, clientSecret: '', webhookSecret: '' },
        };
      case 'save-failed':
        return { ...state, busy: false, error: action.error };
    }
  };
}

/** The ceiling Save stores: the ticked bundles' scopes and the always-on ones, each once. */
export function ceilingScopes(spec: AppRegistrationSpec, checkedIds: ReadonlySet<string>): string {
  return [...new Set([...scopesOfOptions(spec.options, checkedIds), ...spec.alwaysScopes])].join(
    ' '
  );
}

/** What Save sends: trimmed values, and each secret only when one was typed. */
export function saveBody(
  spec: AppRegistrationSpec,
  fields: AppRegistrationFields
): Record<string, unknown> {
  const clientSecret = fields.clientSecret.trim();
  const webhookSecret = fields.webhookSecret.trim();
  const redirectUri = fields.redirectUri.trim();
  return {
    clientId: fields.clientId.trim(),
    ...(spec.directory ? { directoryTenantId: fields.directoryTenantId.trim() } : {}),
    // Blank means keep the stored secret — omit it from the payload.
    ...(clientSecret ? { clientSecret } : {}),
    ...(spec.webhookSecret && webhookSecret ? { webhookSecret } : {}),
    enabled: fields.enabled,
    scopes: ceilingScopes(spec, fields.checkedIds),
    ...(spec.redirectUri && redirectUri ? { redirectUri } : {}),
  };
}

export const STORED_SECRET_PLACEHOLDER = 'Stored — leave blank to keep';

/** How a secret field reads: required until one is stored, then blank means keep. */
export function secretField(stored: boolean): {
  required: boolean;
  placeholder: string;
  storedHint: boolean;
} {
  return stored
    ? { required: false, placeholder: STORED_SECRET_PLACEHOLDER, storedHint: true }
    : { required: true, placeholder: '', storedHint: false };
}

/**
 * The header a Bitbucket repo webhook carries its shared secret in
 * (lib/bitbucket-webhook.ts reads it case-insensitively), and the URL
 * form older registrations used, which still works.
 */
export const BITBUCKET_WEBHOOK_HEADER = 'X-Renkei-Webhook-Secret';
export const BITBUCKET_WEBHOOK_LEGACY_QUERY = '?secret=';

/**
 * Bitbucket's webhook secret field: optional, so never required. With one
 * stored it says so; without, it gives the setup instructions (the header,
 * with the URL form as the fallback).
 */
export function webhookSecretField(config: AppRegistrationConfig | null): {
  placeholder: string;
  hint: 'stored' | 'setup';
} {
  return config?.hasWebhookSecret
    ? { placeholder: STORED_SECRET_PLACEHOLDER, hint: 'stored' }
    : { placeholder: '', hint: 'setup' };
}
