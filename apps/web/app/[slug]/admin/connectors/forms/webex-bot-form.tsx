'use client';

import { FormEvent, useEffect, useState } from 'react';
import {
  useConnectorConfig,
  putJson,
  Card,
  StatusPill,
  inputClass,
  labelClass,
  hintClass,
  SaveRow,
} from './shared';
import { LoadingRegion, SkeletonForm } from '@/components/skeleton';
import ExternalLink from '@/components/external-link';

interface WebexBotConfig {
  configured: boolean;
  enabled: boolean;
  displayName: string | null;
  email: string | null;
  hasBotToken: boolean;
}

/**
 * The org's WebEx bot: one long-lived token, pasted once. Optional — without
 * it, notes Renkei leaves people go to their own "Note to Self" space, where
 * WebEx shows them already read. Its own connector_configs row and page,
 * beside "WebEx" (the Integration people grant their own access through).
 */
export function WebexBotForm({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/connectors/webex-bot`;
  const [state, reload] = useConnectorConfig<WebexBotConfig>(url);
  const [botToken, setBotToken] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setEnabled(state.data.configured ? state.data.enabled : true);
  }, [state.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await putJson(url, {
      // Blank means keep the stored token — omit it from the payload.
      ...(botToken.trim() ? { botToken: botToken.trim() } : {}),
      enabled,
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setBotToken('');
    setNotice('Saved');
    reload();
  }

  if (state.loading)
    return (
      <Card title="WebEx bot (notes to people)" status={null}>
        <LoadingRegion label="Loading settings…">
          <SkeletonForm fields={1} />
        </LoadingRegion>
      </Card>
    );
  if (state.error) {
    return (
      <Card title="WebEx bot (notes to people)" status={null}>
        <p className="text-sm text-red-700 dark:text-red-300">{state.error}</p>
      </Card>
    );
  }
  const config = state.data;
  const identity = config?.displayName
    ? `${config.displayName}${config.email ? ` (${config.email})` : ''}`
    : config?.email;

  return (
    <Card
      title="WebEx bot (notes to people)"
      status={
        <StatusPill configured={config?.configured ?? false} enabled={config?.enabled ?? false} />
      }
    >
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Optional. A{' '}
        <ExternalLink
          href="https://developer.webex.com/my-apps/new/bot"
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          Bot
        </ExternalLink>{' '}
        that leaves people their notes — digests, reminders, an agent&rsquo;s &ldquo;I did
        this&rdquo; — as a direct message. A note a person posts to themself is theirs, so WebEx
        marks it read as it lands and shows no badge; a message from the bot arrives unread, with
        WebEx&rsquo;s own notification. The bot reads nothing: every read still runs as the person.
        Without one, notes go to each person&rsquo;s own &ldquo;Note to Self&rdquo; space.
      </p>
      <form onSubmit={(e) => void save(e)} className="space-y-3">
        <div>
          <label htmlFor="wxb-token" className={labelClass}>
            Bot access token
          </label>
          <input
            id="wxb-token"
            type="password"
            required={!config?.hasBotToken}
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={config?.hasBotToken ? 'Stored — leave blank to keep' : ''}
            className={`${inputClass} font-mono`}
          />
          <p className={hintClass}>
            {config?.hasBotToken
              ? `Stored${identity ? ` for ${identity}` : ''} and never shown; leave blank to keep it.`
              : 'Checked against WebEx when saved, so a wrong token is refused here rather than failing every note quietly.'}
          </p>
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
