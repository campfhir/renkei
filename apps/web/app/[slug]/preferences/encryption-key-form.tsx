'use client';

/**
 * The person's encryption key (docs/user-encryption-keys-design.md, "Your
 * own key"). Two states, and the moves between them:
 *
 *   Managed by Renkei — the default. The key is derived from the server's
 *     master key and the person's salt; nothing to remember, nothing to
 *     lose. From here they may switch to their own passphrase.
 *   Your own key — derived from a passphrase the server never stores. The
 *     server holds it only for an unlock window the person chooses, so
 *     when the window ends their chats and connectors read as locked
 *     until they type the passphrase again. From here: lock now, unlock,
 *     change the passphrase, or go back to the managed key.
 *
 * Every move but "lock" takes the passphrase, and the warnings are blunt
 * on purpose: a forgotten passphrase is unrecoverable, and nobody at
 * Renkei can help with it. That is the point of the feature.
 */

import { useState, type FormEvent } from 'react';
import type { EncryptionKeyView } from '@/lib/encryption-key-view';

const MIN_CHARS = 12;
const HOURS_OPTIONS: readonly { value: number; label: string }[] = [
  { value: 1, label: '1 hour' },
  { value: 8, label: '8 hours' },
  { value: 24, label: '24 hours' },
  { value: 24 * 7, label: '7 days' },
  { value: 24 * 30, label: '30 days' },
];

type Panel = 'adopt' | 'unlock' | 'revert' | null;

interface Failure {
  code: string;
  error: string;
}

function whenText(iso: string | null): string {
  if (!iso) return '';
  const at = new Date(iso);
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function EncryptionKeyForm({
  tenantId,
  initial,
}: {
  tenantId: string;
  initial: EncryptionKeyView;
}) {
  const [status, setStatus] = useState<EncryptionKeyView>(initial);
  const [panel, setPanel] = useState<Panel>(null);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function open(next: Panel) {
    setPanel(next);
    setPassphrase('');
    setConfirm('');
    setFailure(null);
    setNotice(null);
  }

  async function post(body: Record<string, unknown>): Promise<EncryptionKeyView | null> {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/tenant/${tenantId}/encryption-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json: unknown = await response.json().catch(() => null);
      const record: Record<string, unknown> =
        typeof json === 'object' && json !== null && !Array.isArray(json)
          ? Object.fromEntries(Object.entries(json))
          : {};
      if (!response.ok) {
        setFailure({
          code: typeof record.code === 'string' ? record.code : 'failed',
          error: typeof record.error === 'string' ? record.error : 'That did not work. Try again.',
        });
        return null;
      }
      const view: EncryptionKeyView = {
        mode: record.mode === 'own' ? 'own' : 'managed',
        locked: record.locked === true,
        unlockedUntil: typeof record.unlockedUntil === 'string' ? record.unlockedUntil : null,
        version: typeof record.version === 'number' ? record.version : 0,
        rotatedAt: typeof record.rotatedAt === 'string' ? record.rotatedAt : null,
      };
      setStatus(view);
      return view;
    } catch {
      setFailure({ code: 'network', error: 'Could not reach Renkei. Try again.' });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (panel === 'adopt') {
      if (passphrase.length < MIN_CHARS) {
        setFailure({ code: 'passphrase', error: `Use at least ${MIN_CHARS} characters.` });
        return;
      }
      if (passphrase !== confirm) {
        setFailure({ code: 'passphrase', error: 'The two passphrases do not match.' });
        return;
      }
      const view = await post({ action: 'adopt', passphrase, hours });
      if (view) {
        setPanel(null);
        setNotice(
          status.mode === 'own'
            ? 'Your passphrase is changed. Everything you hold is sealed under the new key.'
            : 'You are on your own key now. Everything you hold is sealed under it.'
        );
      }
    } else if (panel === 'unlock') {
      const view = await post({ action: 'unlock', passphrase, hours });
      if (view) {
        setPanel(null);
        setNotice('Unlocked.');
      }
    } else if (panel === 'revert') {
      const view = await post({ action: 'revert', passphrase });
      if (view) {
        setPanel(null);
        setNotice('Back on the managed key. Nothing to remember any more.');
      }
    }
    setPassphrase('');
    setConfirm('');
  }

  async function lock() {
    const view = await post({ action: 'lock' });
    if (view) {
      setPanel(null);
      setNotice('Locked. Your chats and connectors stay sealed until you unlock.');
    }
  }

  const own = status.mode === 'own';
  const passphraseInput =
    'mt-1 block w-full rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';
  const secondaryButton =
    'rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900';
  const primaryButton =
    'rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';

  return (
    <section
      aria-labelledby="encryption-key-heading"
      data-testid="encryption-key"
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
    >
      <h3 id="encryption-key-heading" className="font-semibold">
        Encryption key
      </h3>
      <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
        Your chats, your memory and the credentials behind your connectors are sealed under a key
        that is yours. Shared chats are opened with your key and resealed for the people you share
        them with; connector credentials never are.
      </p>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-gray-500 dark:text-gray-400">Key</dt>
        <dd data-testid="encryption-key-mode" className="font-medium">
          {own ? 'Your own key' : 'Managed by Renkei'}
        </dd>
        {own ? (
          <>
            <dt className="text-gray-500 dark:text-gray-400">State</dt>
            <dd data-testid="encryption-key-state">
              {status.locked ? (
                <span className="font-medium text-amber-700 dark:text-amber-400">Locked</span>
              ) : (
                <>
                  <span className="font-medium text-green-700 dark:text-green-400">Unlocked</span>
                  {status.unlockedUntil ? (
                    <span className="text-gray-600 dark:text-gray-400">
                      {' '}
                      until {whenText(status.unlockedUntil)}
                    </span>
                  ) : null}
                </>
              )}
            </dd>
          </>
        ) : null}
      </dl>

      {own && status.locked ? (
        <p
          className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
          role="status"
        >
          While your key is locked, your chats cannot be read or continued and your connectors
          cannot act for you. Unlock it to carry on.
        </p>
      ) : null}

      {panel === null ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {!own ? (
            <button type="button" className={primaryButton} onClick={() => open('adopt')}>
              Use my own passphrase
            </button>
          ) : null}
          {own && status.locked ? (
            <button type="button" className={primaryButton} onClick={() => open('unlock')}>
              Unlock
            </button>
          ) : null}
          {own && !status.locked ? (
            <>
              <button
                type="button"
                className={secondaryButton}
                disabled={busy}
                onClick={() => void lock()}
              >
                {busy ? 'Locking…' : 'Lock now'}
              </button>
              <button type="button" className={secondaryButton} onClick={() => open('adopt')}>
                Change passphrase
              </button>
            </>
          ) : null}
          {own ? (
            <button type="button" className={secondaryButton} onClick={() => open('revert')}>
              Go back to the managed key
            </button>
          ) : null}
          {notice ? (
            <span className="text-sm text-green-700 dark:text-green-400" role="status">
              {notice}
            </span>
          ) : null}
          {failure ? (
            <span className="text-sm text-red-600 dark:text-red-400" role="alert">
              {failure.error}
            </span>
          ) : null}
        </div>
      ) : (
        <form
          onSubmit={(event) => void submit(event)}
          className="mt-3 max-w-md rounded-md border border-gray-200 p-3 dark:border-gray-800"
          data-testid={`encryption-key-${panel}`}
        >
          {panel === 'adopt' ? (
            <>
              <p className="text-sm font-medium">
                {own ? 'Change your passphrase' : 'Switch to your own passphrase'}
              </p>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                Your key will be derived from this passphrase. Renkei never stores the passphrase
                and cannot recover it:{' '}
                <span className="font-medium text-gray-800 dark:text-gray-200">
                  if you forget it, every chat and connector sealed under it is lost for good.
                </span>{' '}
                Keep it somewhere safe.
              </p>
              <label htmlFor="encryption-key-passphrase" className="mt-3 block text-sm">
                Passphrase
                <input
                  id="encryption-key-passphrase"
                  type="password"
                  autoComplete="new-password"
                  aria-describedby="encryption-key-passphrase-hint"
                  className={passphraseInput}
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  minLength={MIN_CHARS}
                  required
                />
              </label>
              <p
                id="encryption-key-passphrase-hint"
                className="mt-0.5 text-xs text-gray-500 dark:text-gray-400"
              >
                At least {MIN_CHARS} characters. A few unrelated words are easier to keep than a
                short jumble.
              </p>
              <label className="mt-3 block text-sm">
                Confirm passphrase
                <input
                  type="password"
                  autoComplete="new-password"
                  className={passphraseInput}
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  required
                />
              </label>
            </>
          ) : null}
          {panel === 'unlock' ? (
            <>
              <p className="text-sm font-medium">Unlock your key</p>
              <label className="mt-3 block text-sm">
                Passphrase
                <input
                  type="password"
                  autoComplete="current-password"
                  className={passphraseInput}
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  required
                />
              </label>
            </>
          ) : null}
          {panel === 'revert' ? (
            <>
              <p className="text-sm font-medium">Go back to the managed key</p>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                Everything you hold is resealed under a key Renkei derives for you. Nothing to
                remember after this, and nothing lost if you forget this passphrase later. Your
                passphrase is the proof it is you asking.
              </p>
              <label className="mt-3 block text-sm">
                Passphrase
                <input
                  type="password"
                  autoComplete="current-password"
                  className={passphraseInput}
                  value={passphrase}
                  onChange={(event) => setPassphrase(event.target.value)}
                  required
                />
              </label>
            </>
          ) : null}
          {panel !== 'revert' ? (
            <>
              <label htmlFor="encryption-key-hours" className="mt-3 block text-sm">
                Stay unlocked for
                <select
                  id="encryption-key-hours"
                  aria-describedby="encryption-key-hours-hint"
                  className="mt-1 block rounded-md border border-gray-300 bg-white px-2.5 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
                  value={hours}
                  onChange={(event) => setHours(Number(event.target.value))}
                >
                  {HOURS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <p
                id="encryption-key-hours-hint"
                className="mt-0.5 text-xs text-gray-500 dark:text-gray-400"
              >
                Renkei holds your key for this long so your chats keep working while you are away
                from the page. When it runs out, everything reads as locked until you type the
                passphrase again.
              </p>
            </>
          ) : null}
          {failure ? (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
              {failure.error}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="submit" className={primaryButton} disabled={busy}>
              {busy
                ? 'Working…'
                : panel === 'adopt'
                  ? own
                    ? 'Change passphrase'
                    : 'Switch to my own key'
                  : panel === 'unlock'
                    ? 'Unlock'
                    : 'Go back to the managed key'}
            </button>
            <button
              type="button"
              className={secondaryButton}
              disabled={busy}
              onClick={() => open(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
