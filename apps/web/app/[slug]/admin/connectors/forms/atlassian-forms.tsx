'use client';

import { FormEvent, ReactNode, useEffect, useState } from 'react';
import {
  ATLASSIAN_SCOPE_OPTIONS,
  ATLASSIAN_SCOPE_GROUPS,
  ATLASSIAN_JSM_SCOPE_OPTIONS,
  ATLASSIAN_JSM_SCOPE_GROUPS,
  ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS,
  ATLASSIAN_CONFLUENCE_SCOPE_GROUPS,
  ATLASSIAN_BITBUCKET_SCOPE_OPTIONS,
  ATLASSIAN_BITBUCKET_SCOPE_GROUPS,
  ATLASSIAN_ADMIN_SCOPE_OPTIONS,
  ATLASSIAN_ADMIN_SCOPE_GROUPS,
  ATLASSIAN_OFFLINE_SCOPE,
  BITBUCKET_ACCOUNT_SCOPE,
} from '@/lib/atlassian-scopes';
import type { ScopeGroup, ScopeOption } from '@/lib/scope-catalog';
import ScopePicker from '@/components/scope-picker';
import ExternalLink from '@/components/external-link';
import { optionWithin, scopesOfOptions } from '@/lib/scope-catalog';
import {
  useConnectorConfig,
  putJson,
  Card,
  StatusPill,
  CallbackUrl,
  inputClass,
  labelClass,
  hintClass,
  SaveRow,
} from './shared';
import { LoadingRegion, SkeletonForm } from '@/components/skeleton';

/* ----------------------------------------------------------------------- */

interface AtlassianConfig {
  configured: boolean;
  enabled: boolean;
  clientId: string | null;
  scopes: string | null;
  redirectUri: string | null;
  hasClientSecret: boolean;
  hasWebhookSecret?: boolean;
}

export function AtlassianForm({ slug, origin }: { slug: string; origin: string | null }) {
  return (
    <AtlassianAppForm
      slug={slug}
      origin={origin}
      connector="atlassian"
      title="Atlassian (Jira)"
      groups={ATLASSIAN_SCOPE_GROUPS}
      options={ATLASSIAN_SCOPE_OPTIONS}
    />
  );
}

export function AtlassianJsmForm({ slug, origin }: { slug: string; origin: string | null }) {
  return (
    <AtlassianAppForm
      slug={slug}
      origin={origin}
      connector="atlassian-jsm"
      title="Atlassian (Service Management & Ops)"
      groups={ATLASSIAN_JSM_SCOPE_GROUPS}
      options={ATLASSIAN_JSM_SCOPE_OPTIONS}
    />
  );
}

export function AtlassianConfluenceForm({ slug, origin }: { slug: string; origin: string | null }) {
  return (
    <AtlassianAppForm
      slug={slug}
      origin={origin}
      connector="atlassian-confluence"
      title="Atlassian (Confluence)"
      groups={ATLASSIAN_CONFLUENCE_SCOPE_GROUPS}
      options={ATLASSIAN_CONFLUENCE_SCOPE_OPTIONS}
    />
  );
}

export function AtlassianAdminForm({ slug, origin }: { slug: string; origin: string | null }) {
  return (
    <AtlassianAppForm
      slug={slug}
      origin={origin}
      connector="atlassian-admin"
      title="Atlassian (Jira Administration)"
      groups={ATLASSIAN_ADMIN_SCOPE_GROUPS}
      options={ATLASSIAN_ADMIN_SCOPE_OPTIONS}
      intro={
        <>
          A separate OAuth 2.0 (3LO) app from{' '}
          <ExternalLink
            href="https://developer.atlassian.com/console/myapps/"
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            developer.atlassian.com
          </ExternalLink>
          , holding Jira&apos;s <strong>classic</strong> scopes (Permissions → Jira API → Classic
          scopes) — the Plans and Forms APIs accept no others, and one app cannot mix classic with
          the granular scopes the Jira app uses. Its callback URL must be{' '}
          <CallbackUrl origin={origin} />. Only Jira admins get anything from connecting it: Jira
          still checks Administer Jira or Administer Projects on every call.
        </>
      }
    />
  );
}

export function AtlassianBitbucketForm({ slug, origin }: { slug: string; origin: string | null }) {
  return (
    <AtlassianAppForm
      slug={slug}
      origin={origin}
      connector="atlassian-bitbucket"
      title="Atlassian (Bitbucket)"
      groups={ATLASSIAN_BITBUCKET_SCOPE_GROUPS}
      options={ATLASSIAN_BITBUCKET_SCOPE_OPTIONS}
      // No offline_access on Bitbucket — refresh tokens are always issued;
      // `account` rides instead, for the identity read at connect time.
      alwaysScope={BITBUCKET_ACCOUNT_SCOPE}
      intro={
        <>
          An OAuth consumer from your Bitbucket workspace&apos;s settings (Workspace settings →
          OAuth consumers). Its callback URL must be <CallbackUrl origin={origin} />, and it needs
          &quot;This is a private consumer&quot; checked.
        </>
      }
      scopeHint={
        <>
          This is the ceiling: users can narrow it when they connect, never widen it. Every checked
          scope must also be granted to the consumer on bitbucket.org — and unlike the other
          Atlassian apps, Bitbucket&apos;s consent screen always shows the consumer&apos;s full set:
          narrowing here decides what Renkei USES, not what the token carries.{' '}
          <code className="font-mono text-xs">{BITBUCKET_ACCOUNT_SCOPE}</code> is always included
          (it is how Renkei learns whose grant it stored). Users who already connected keep their
          old choices until they reconnect.
        </>
      }
      showWebhookSecret
    />
  );
}

/**
 * One form serves every Atlassian app registration — Jira, "Renkei JSM"
 * (the split exists because Atlassian's all-of scope enforcement times its
 * consent-URL length cliff makes the combined scope union unfittable on one
 * app), Confluence, Bitbucket and Jira Administration. Each connector stores
 * its own client id/secret and scope ceiling.
 */
function AtlassianAppForm({
  slug,
  origin,
  connector,
  title,
  groups,
  options,
  alwaysScope = ATLASSIAN_OFFLINE_SCOPE,
  intro,
  scopeHint,
  showWebhookSecret = false,
}: {
  slug: string;
  origin: string | null;
  connector: string;
  title: string;
  groups: ScopeGroup[];
  options: ScopeOption[];
  /** The scope appended to every save, never offered as a checkbox. */
  alwaysScope?: string;
  /** Replaces the developer.atlassian.com blurb for non-3LO apps. */
  intro?: ReactNode;
  /** Replaces the default ceiling hint under the scope picker. */
  scopeHint?: ReactNode;
  /**
   * Bitbucket only: a shared secret checked against a `?secret=` query
   * parameter on a repo webhook someone registers by hand pointing at
   * app/api/webhooks/bitbucket/[tenantId]/route.ts — Bitbucket Cloud has
   * no HMAC-signed delivery the way a GitHub App does.
   */
  showWebhookSecret?: boolean;
}) {
  const url = `/api/admin/${slug}/connectors/${connector}`;
  const [state, reload] = useConnectorConfig<AtlassianConfig>(url);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  // Checked capability bundles, offline_access excluded — it is always sent,
  // never a choice.
  const [checkedIds, setCheckedIds] = useState<Set<string>>(
    () => new Set(options.filter((option) => option.defaultChecked).map((option) => option.id))
  );
  const [redirectUri, setRedirectUri] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setClientId(state.data.clientId ?? '');
    if (state.data.configured && state.data.scopes) {
      // An option is checked when the stored ceiling covers its whole bundle.
      // A ceiling saved before the granular migration matches nothing —
      // leave the defaults checked so re-saving lands on sane granular scopes.
      const stored = new Set(state.data.scopes.split(/\s+/));
      const matching = options.filter((option) => optionWithin(option, stored));
      if (matching.length > 0) setCheckedIds(new Set(matching.map((option) => option.id)));
    }
    setRedirectUri(state.data.redirectUri ?? '');
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  function toggleOption(optionId: string, on: boolean) {
    setCheckedIds((current) => {
      const next = new Set(current);
      if (on) next.add(optionId);
      else next.delete(optionId);
      return next;
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const scopes = [...scopesOfOptions(options, checkedIds), alwaysScope].join(' ');
    const failure = await putJson(url, {
      clientId: clientId.trim(),
      // Blank means keep the stored secret — omit it from the payload.
      ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
      ...(showWebhookSecret && webhookSecret.trim() ? { webhookSecret: webhookSecret.trim() } : {}),
      enabled,
      scopes,
      ...(redirectUri.trim() ? { redirectUri: redirectUri.trim() } : {}),
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setClientSecret('');
    setWebhookSecret('');
    setNotice('Saved');
    reload();
  }

  if (state.loading)
    return (
      <Card title={title} status={null}>
        <LoadingRegion label="Loading settings…">
          <SkeletonForm fields={3} />
        </LoadingRegion>
      </Card>
    );
  if (state.error) {
    return (
      <Card title={title} status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;

  return (
    <Card
      title={title}
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        {intro ?? (
          <>
            The OAuth 2.0 (3LO) app from{' '}
            <ExternalLink
              href="https://developer.atlassian.com/console/myapps/"
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              developer.atlassian.com
            </ExternalLink>
            . Its callback URL must be <CallbackUrl origin={origin} />.
          </>
        )}
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor={`${connector}-client-id`} className={labelClass}>
            Client ID
          </label>
          <input
            id={`${connector}-client-id`}
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className={`${inputClass} font-mono`}
          />
        </div>
        <div>
          <label htmlFor={`${connector}-client-secret`} className={labelClass}>
            Client secret
          </label>
          <input
            id={`${connector}-client-secret`}
            type="password"
            required={!config?.hasClientSecret}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={config?.hasClientSecret ? 'Stored — leave blank to keep' : ''}
            className={`${inputClass} font-mono`}
          />
          {config?.hasClientSecret && (
            <p className={hintClass}>A secret is stored but never shown; leave blank to keep it.</p>
          )}
        </div>
        {showWebhookSecret && (
          <div>
            <label htmlFor={`${connector}-webhook-secret`} className={labelClass}>
              Webhook secret <span className="font-normal text-gray-500">(optional)</span>
            </label>
            <input
              id={`${connector}-webhook-secret`}
              type="password"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder={config?.hasWebhookSecret ? 'Stored — leave blank to keep' : ''}
              className={`${inputClass} font-mono`}
            />
            {config?.hasWebhookSecret ? (
              <p className={hintClass}>
                A secret is stored but never shown; leave blank to keep it.
              </p>
            ) : (
              <p className={hintClass}>
                Set this to the same value as a repo webhook&apos;s own secret query parameter
                (Repository settings → Webhooks → add one pointing at{' '}
                <code className="font-mono">
                  /api/webhooks/bitbucket/&lt;tenant id&gt;?secret=&lt;this value&gt;
                </code>
                ) to turn on pull request pipeline subscriptions for Bitbucket repositories.
              </p>
            )}
          </div>
        )}
        <div>
          <fieldset>
            <legend className={labelClass}>What users may grant</legend>
            <ScopePicker
              groups={groups}
              options={options}
              checked={checkedIds}
              onToggle={toggleOption}
            />
            <p className={hintClass}>
              {scopeHint ?? (
                <>
                  This is the ceiling: users can narrow it when they connect, never widen it. Every
                  checked scope must also be granted to the app on developer.atlassian.com —
                  Atlassian refuses the authorize step otherwise.{' '}
                  <code className="font-mono text-xs">{ATLASSIAN_OFFLINE_SCOPE}</code> is always
                  included (without it grants die within an hour). Users who already connected keep
                  their old scopes until they reconnect.
                </>
              )}
            </p>
          </fieldset>
        </div>
        <div>
          <label htmlFor={`${connector}-redirect`} className={labelClass}>
            Redirect URI override <span className="font-normal text-gray-500">(optional)</span>
          </label>
          <input
            id={`${connector}-redirect`}
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            placeholder="Defaults to this origin + /api/oauth/callback"
            className={`${inputClass} font-mono`}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <SaveRow busy={busy} notice={notice} error={error} />
      </form>
    </Card>
  );
}
