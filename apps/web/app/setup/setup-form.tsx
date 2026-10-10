'use client';

import { FormEvent, useState } from 'react';
import { SETUP_SECRET_HEADER } from '@/lib/setup-secret-header';

interface Fields {
  discoveryEndpoint: string;
  clientId: string;
  clientSecret: string;
  roleClaim: string;
  operatorIdpValue: string;
  userIdpValue: string;
  groupsClaim: string;
  setupSecret: string;
}

const EMPTY: Fields = {
  discoveryEndpoint: '',
  clientId: '',
  clientSecret: '',
  roleClaim: 'roles',
  operatorIdpValue: 'renkei-operator',
  userIdpValue: 'renkei-user',
  groupsClaim: '',
  setupSecret: '',
};

const inputClass =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-black focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white';
const labelClass = 'block text-sm font-medium mb-1';

export default function SetupForm() {
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const set = (key: keyof Fields) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setFields((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/oidc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [SETUP_SECRET_HEADER]: fields.setupSecret.trim(),
        },
        body: JSON.stringify({
          discoveryEndpoint: fields.discoveryEndpoint.trim(),
          clientId: fields.clientId.trim(),
          clientSecret: fields.clientSecret,
          roleClaim: fields.roleClaim.trim() || undefined,
          operatorIdpValue: fields.operatorIdpValue.trim() || undefined,
          userIdpValue: fields.userIdpValue.trim() || undefined,
          groupsClaim: fields.groupsClaim.trim() || undefined,
        }),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message =
          typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
            ? body.error
            : `Saving failed (${response.status})`;
        setError(message);
        return;
      }
      setDone(true);
    } catch {
      setError('Saving failed. Check the server log and try again.');
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <section
        className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm dark:border-green-900 dark:bg-green-950/40"
        data-testid="setup-done"
      >
        <p className="font-medium text-green-800 dark:text-green-300">Identity provider saved.</p>
        <p className="mt-1 text-gray-700 dark:text-gray-300">
          Sign in with an account that carries the operator value to finish configuring the
          organization.
        </p>
        <a
          href="/api/auth/oidc/login"
          className="mt-3 inline-block rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
        >
          Sign in
        </a>
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <fieldset className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <legend className="px-1 text-sm font-semibold">Identity provider</legend>
        <div>
          <label htmlFor="discoveryEndpoint" className={labelClass}>
            OpenID Connect discovery URL
          </label>
          <input
            id="discoveryEndpoint"
            type="url"
            required
            autoFocus
            placeholder="https://login.microsoftonline.com/<tenant>/v2.0/.well-known/openid-configuration"
            value={fields.discoveryEndpoint}
            onChange={set('discoveryEndpoint')}
            className={inputClass}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="clientId" className={labelClass}>
              Client ID
            </label>
            <input
              id="clientId"
              required
              value={fields.clientId}
              onChange={set('clientId')}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="clientSecret" className={labelClass}>
              Client secret
            </label>
            <input
              id="clientSecret"
              type="password"
              required
              value={fields.clientSecret}
              onChange={set('clientSecret')}
              className={inputClass}
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <legend className="px-1 text-sm font-semibold">Who is an operator</legend>
        <p className="text-xs text-gray-600 dark:text-gray-400">
          Sign-in reads one claim from the id_token and matches its values: people carrying the
          operator value administer Renkei, people carrying the user value use it. Leave the
          claim empty to let everyone who can sign in use Renkei as a user.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="roleClaim" className={labelClass}>
              Role claim
            </label>
            <input
              id="roleClaim"
              value={fields.roleClaim}
              onChange={set('roleClaim')}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="operatorIdpValue" className={labelClass}>
              Operator value
            </label>
            <input
              id="operatorIdpValue"
              value={fields.operatorIdpValue}
              onChange={set('operatorIdpValue')}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="userIdpValue" className={labelClass}>
              User value
            </label>
            <input
              id="userIdpValue"
              value={fields.userIdpValue}
              onChange={set('userIdpValue')}
              className={inputClass}
            />
          </div>
        </div>
        <div>
          <label htmlFor="groupsClaim" className={labelClass}>
            Groups claim{' '}
            <span className="font-normal text-gray-500">
              (optional; empty means nobody is in any group)
            </span>
          </label>
          <input
            id="groupsClaim"
            value={fields.groupsClaim}
            onChange={set('groupsClaim')}
            className={inputClass}
          />
        </div>
      </fieldset>

      <div>
        <label htmlFor="setupSecret" className={labelClass}>
          Setup secret{' '}
          <span className="font-normal text-gray-500">(SETUP_SECRET in the app&apos;s environment)</span>
        </label>
        <input
          id="setupSecret"
          required
          autoComplete="off"
          value={fields.setupSecret}
          onChange={set('setupSecret')}
          className={inputClass}
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={saving}
        className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700 disabled:bg-blue-400"
      >
        {saving ? 'Saving…' : 'Save and continue'}
      </button>
    </form>
  );
}
