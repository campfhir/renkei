/**
 * The OAuth app registration forms (app-registration-form.model.ts) — the
 * Atlassian apps and Entra Developer — as an operator would describe them.
 * These were the form halves of jira-admin.spec.ts and
 * entra-developer.spec.ts, and the stored/setup switch of
 * bitbucket-webhook-hint.spec.ts; what the save routes store is their
 * route tests (app/api/admin/connectors/{atlassian-admin,entra-developer}).
 */

import {
  ATLASSIAN_ADMIN_SCOPE_OPTIONS,
  ATLASSIAN_BITBUCKET_SCOPE_OPTIONS,
  ATLASSIAN_OFFLINE_SCOPE,
  BITBUCKET_ACCOUNT_SCOPE,
} from '@/lib/atlassian-scopes';
import {
  ENTRA_DEVELOPER_REQUIRED_SCOPES,
  ENTRA_DEVELOPER_SCOPE_OPTIONS,
} from '@/lib/entra-developer-scopes';
import { BITBUCKET_WEBHOOK_SECRET_HEADER } from '@/lib/bitbucket-webhook';
import {
  appRegistrationReducer,
  BITBUCKET_WEBHOOK_HEADER,
  ceilingScopes,
  initialAppRegistration,
  saveBody,
  secretField,
  webhookSecretField,
  type AppRegistrationAction,
  type AppRegistrationConfig,
  type AppRegistrationSpec,
  type AppRegistrationState,
} from './app-registration-form.model';

const JIRA_ADMIN: AppRegistrationSpec = {
  options: ATLASSIAN_ADMIN_SCOPE_OPTIONS,
  alwaysScopes: [ATLASSIAN_OFFLINE_SCOPE],
  redirectUri: true,
};
const BITBUCKET: AppRegistrationSpec = {
  options: ATLASSIAN_BITBUCKET_SCOPE_OPTIONS,
  alwaysScopes: [BITBUCKET_ACCOUNT_SCOPE],
  redirectUri: true,
  webhookSecret: true,
};
const ENTRA: AppRegistrationSpec = {
  options: ENTRA_DEVELOPER_SCOPE_OPTIONS,
  alwaysScopes: ENTRA_DEVELOPER_REQUIRED_SCOPES,
  directory: true,
};

const config = (more: Partial<AppRegistrationConfig> = {}): AppRegistrationConfig => ({
  configured: true,
  enabled: true,
  clientId: 'client-1',
  scopes: null,
  hasClientSecret: true,
  ...more,
});

function run(spec: AppRegistrationSpec, actions: AppRegistrationAction[]): AppRegistrationState {
  return actions.reduce(appRegistrationReducer(spec), initialAppRegistration(spec));
}

const sorted = (scopes: unknown) => String(scopes).split(' ').sort();

describe('a registration never saved', () => {
  it('starts with every box its catalog ticks, and on', () => {
    const state = run(JIRA_ADMIN, [
      { type: 'loaded', config: config({ configured: false, enabled: false, clientId: null }) },
    ]);
    expect([...state.fields.checkedIds].sort()).toEqual(
      ['jira-admin-read', 'jira-admin-site', 'jira-admin-spaces'].sort()
    );
    expect(state.fields.enabled).toBe(true);
    expect(state.fields.clientId).toBe('');
  });

  it('asks for a secret: the field is required with nothing stored', () => {
    expect(secretField(false)).toEqual({ required: true, placeholder: '', storedHint: false });
  });
});

describe('Jira Administration', () => {
  it('holding the newest box back saves the ceiling without it, offline_access always included', () => {
    const state = run(JIRA_ADMIN, [
      { type: 'toggle', optionId: 'jira-admin-spaces', on: false },
      {
        type: 'edit',
        patch: { clientId: '  e2e-admin-client ', clientSecret: 'e2e-admin-secret' },
      },
    ]);
    const body = saveBody(JIRA_ADMIN, state.fields);
    expect(body.clientId).toBe('e2e-admin-client');
    expect(body.clientSecret).toBe('e2e-admin-secret');
    expect(body.enabled).toBe(true);
    expect(sorted(body.scopes)).toEqual(
      ['manage:jira-configuration', 'offline_access', 'read:jira-user', 'read:jira-work'].sort()
    );
    // No override typed: none sent, so the default callback applies.
    expect(body).not.toHaveProperty('redirectUri');
  });

  it('a stored ceiling ticks exactly the boxes whose whole bundle it covers', () => {
    const state = run(JIRA_ADMIN, [
      {
        type: 'loaded',
        config: config({ scopes: 'read:jira-user read:jira-work offline_access' }),
      },
    ]);
    expect([...state.fields.checkedIds]).toEqual(['jira-admin-read']);
  });

  it('a ceiling saved before the scope migration ticks nothing, so the defaults stay', () => {
    const state = run(JIRA_ADMIN, [
      { type: 'loaded', config: config({ scopes: 'read:jira-ancient offline_access' }) },
    ]);
    expect(state.fields.checkedIds.size).toBe(3);
  });

  it('shows a registration switched off as off, and its override as typed', () => {
    const state = run(JIRA_ADMIN, [
      { type: 'loaded', config: config({ enabled: false, redirectUri: 'https://x/cb' }) },
    ]);
    expect(state.fields.enabled).toBe(false);
    expect(saveBody(JIRA_ADMIN, state.fields).redirectUri).toBe('https://x/cb');
  });
});

describe('secrets', () => {
  it('a blank secret is left out of the save, so the stored one is kept', () => {
    const state = run(JIRA_ADMIN, [
      { type: 'loaded', config: config() },
      { type: 'edit', patch: { clientSecret: '   ' } },
    ]);
    expect(saveBody(JIRA_ADMIN, state.fields)).not.toHaveProperty('clientSecret');
  });

  it('with a secret stored the field reads "Stored — leave blank to keep" and is not required', () => {
    expect(secretField(true)).toEqual({
      required: false,
      placeholder: 'Stored — leave blank to keep',
      storedHint: true,
    });
  });

  it('a save clears the typed secrets and says Saved', () => {
    const state = run(BITBUCKET, [
      { type: 'edit', patch: { clientSecret: 's', webhookSecret: 'w' } },
      { type: 'saving' },
      { type: 'saved' },
    ]);
    expect(state.fields.clientSecret).toBe('');
    expect(state.fields.webhookSecret).toBe('');
    expect(state.notice).toBe('Saved');
    expect(state.busy).toBe(false);
  });

  it('a refused save keeps what was typed and shows why; the next try clears it', () => {
    const failed = run(JIRA_ADMIN, [
      { type: 'edit', patch: { clientSecret: 's' } },
      { type: 'saving' },
      { type: 'save-failed', error: 'clientSecret is required (none stored yet)' },
    ]);
    expect(failed.error).toBe('clientSecret is required (none stored yet)');
    expect(failed.fields.clientSecret).toBe('s');
    const retry = appRegistrationReducer(JIRA_ADMIN)(failed, { type: 'saving' });
    expect(retry.error).toBeNull();
    expect(retry.busy).toBe(true);
  });
});

describe('Bitbucket', () => {
  it('sends `account` instead of offline_access, and the webhook secret only when typed', () => {
    const blank = run(BITBUCKET, [{ type: 'edit', patch: { clientId: 'c' } }]);
    const body = saveBody(BITBUCKET, blank.fields);
    expect(String(body.scopes).split(' ')).toContain('account');
    expect(String(body.scopes).split(' ')).not.toContain('offline_access');
    expect(body).not.toHaveProperty('webhookSecret');

    const typed = run(BITBUCKET, [{ type: 'edit', patch: { webhookSecret: ' hook ' } }]);
    expect(saveBody(BITBUCKET, typed.fields).webhookSecret).toBe('hook');
  });

  it('other Atlassian apps never send a webhook secret', () => {
    const state = run(JIRA_ADMIN, [{ type: 'edit', patch: { webhookSecret: 'hook' } }]);
    expect(saveBody(JIRA_ADMIN, state.fields)).not.toHaveProperty('webhookSecret');
  });

  it('without a stored webhook secret it gives the setup instructions; with one, says it is stored', () => {
    expect(webhookSecretField(config())).toEqual({ placeholder: '', hint: 'setup' });
    expect(webhookSecretField(config({ hasWebhookSecret: true }))).toEqual({
      placeholder: 'Stored — leave blank to keep',
      hint: 'stored',
    });
  });

  it('the instructions name the header the webhook route reads', () => {
    expect(BITBUCKET_WEBHOOK_HEADER.toLowerCase()).toBe(BITBUCKET_WEBHOOK_SECRET_HEADER);
  });
});

describe('Entra Developer', () => {
  it('holding group lookups back saves the ceiling without Group.Read.All, the required scopes always in', () => {
    const state = run(ENTRA, [
      { type: 'toggle', optionId: 'Group.Read.All', on: false },
      {
        type: 'edit',
        patch: {
          clientId: 'e2e-entra-client',
          directoryTenantId: ' aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee ',
          clientSecret: 'e2e-entra-secret',
        },
      },
    ]);
    const body = saveBody(ENTRA, state.fields);
    expect(body.directoryTenantId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(sorted(body.scopes)).toEqual(
      [
        'Application.Read.All',
        'Application.ReadWrite.All',
        'AppRoleAssignment.ReadWrite.All',
        'User.ReadBasic.All',
        'openid',
        'profile',
        'email',
        'offline_access',
        'User.Read',
      ].sort()
    );
  });

  it('names each scope once, though two boxes share Application.Read.All', () => {
    const scopes = ceilingScopes(ENTRA, initialAppRegistration(ENTRA).fields.checkedIds).split(' ');
    expect(scopes.length).toBe(new Set(scopes).size);
  });

  it('fills the directory from the stored registration, and never sends a redirect override', () => {
    const state = run(ENTRA, [
      { type: 'loaded', config: config({ directoryTenantId: 'dir-1', redirectUri: 'https://x' }) },
    ]);
    expect(state.fields.directoryTenantId).toBe('dir-1');
    expect(saveBody(ENTRA, state.fields)).not.toHaveProperty('redirectUri');
  });

  it('the Atlassian forms never send a directory', () => {
    expect(saveBody(JIRA_ADMIN, initialAppRegistration(JIRA_ADMIN).fields)).not.toHaveProperty(
      'directoryTenantId'
    );
  });
});
