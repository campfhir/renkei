'use client';

/**
 * The person's encryption key, as the preferences page shows it
 * (docs/delegate-key-design.md): a key they hold, not one Renkei derives.
 * What is here is what they can decide:
 *
 *   - how long their agents may run unattended (the automation window),
 *     and "pause now", which revokes it until the next sign-in;
 *   - this device: whether it holds the key, and "forget this device";
 *   - a new key (rotation), shown once like the first;
 *   - the devices asking for the key right now.
 *
 * The KeyGuard (components/key-guard.tsx) does the unprompted work; this
 * section is for the choices.
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { KeyStatusView } from '@/lib/keys/shared';
import { AUTOMATION_WINDOW_DAYS } from '@/lib/keys/shared';
import { forgetUserKey, loadUserKey, saveUserKey } from '@/lib/keys/browser/device-store';
import {
  approveDeviceAsk,
  delegateInBrowser,
  denyDeviceAsk,
  fetchKeyStatus,
  revokeAutomationInBrowser,
  rotateInBrowser,
} from '@/lib/keys/browser/flows';

function whenText(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function EncryptionKeySection({
  tenantId,
  initial,
}: {
  tenantId: string;
  initial: KeyStatusView;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<KeyStatusView>(initial);
  const [deviceHasKey, setDeviceHasKey] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);

  const refresh = useCallback(async () => {
    const [next, key] = await Promise.all([fetchKeyStatus(tenantId), loadUserKey(tenantId)]);
    if (next) setStatus(next);
    setDeviceHasKey(key !== null);
  }, [tenantId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function setWindow(days: number): Promise<void> {
    const key = await loadUserKey(tenantId);
    if (!key) {
      setFailure('This device does not hold your key, so it cannot extend your agents.');
      return;
    }
    setBusy(true);
    setFailure(null);
    const delegated = await delegateInBrowser(tenantId, status, key, { automationDays: days });
    setBusy(false);
    if (!delegated.ok) {
      setFailure(delegated.failure.error);
      return;
    }
    setNotice(
      `Your agents can run until ${whenText(new Date(Date.now() + days * 24 * 60 * 60_000).toISOString())}. Signing in extends this.`
    );
    await refresh();
  }

  async function pauseAutomation(): Promise<void> {
    setBusy(true);
    setFailure(null);
    const revoked = await revokeAutomationInBrowser(tenantId);
    setBusy(false);
    if (!revoked.ok) {
      setFailure(revoked.failure.error);
      return;
    }
    setNotice('Your agents are paused. They run again after your next sign-in.');
    await refresh();
  }

  async function rotate(): Promise<void> {
    setBusy(true);
    setFailure(null);
    const rotated = await rotateInBrowser(tenantId, status, {
      automationDays: status.automationDays,
    });
    setBusy(false);
    setConfirmRotate(false);
    if (!rotated.ok) {
      setFailure(rotated.failure.error);
      return;
    }
    setRevealed(rotated.outcome.shown);
    setNotice('Your key was replaced. Every other device needs the new one.');
    await refresh();
    router.refresh();
  }

  async function forget(): Promise<void> {
    await forgetUserKey(tenantId);
    setNotice(
      'This device no longer holds your key. Next time, type it or approve from another device.'
    );
    await refresh();
  }

  async function confirmRevealed(): Promise<void> {
    const key = await loadUserKey(tenantId);
    if (key) await saveUserKey(tenantId, key, { acknowledged: true });
    setRevealed(null);
  }

  async function decide(requestId: string, approve: boolean): Promise<void> {
    setBusy(true);
    setFailure(null);
    if (approve) {
      const key = await loadUserKey(tenantId);
      if (!key) setFailure('This device does not hold your key, so it cannot share it.');
      else {
        const approved = await approveDeviceAsk(tenantId, requestId, key);
        if (!approved.ok) setFailure(approved.failure.error);
      }
    } else {
      await denyDeviceAsk(tenantId, requestId);
    }
    setBusy(false);
    await refresh();
  }

  const automationOn = status.automationInstances.length > 0 && status.automationUntil !== null;
  const button =
    'rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900';
  const primary =
    'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';

  return (
    <section
      className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
      data-testid="encryption-key"
    >
      <h2 className="text-sm font-semibold">Encryption key</h2>
      {!status.enrolled ? (
        <p
          className="mt-2 text-sm text-gray-600 dark:text-gray-400"
          data-testid="encryption-key-mode"
        >
          Your key is being set up. Reload this page in a moment.
        </p>
      ) : (
        <>
          <p
            className="mt-2 text-sm text-gray-700 dark:text-gray-300"
            data-testid="encryption-key-mode"
          >
            You hold your own key{status.enrolledAt ? ` since ${whenText(status.enrolledAt)}` : ''}.
            Renkei never stores it: your browser hands it to the key service for each session, and
            nothing of yours opens without it.
          </p>

          <div className="mt-4 space-y-1 text-sm" data-testid="encryption-key-automation">
            <p className="font-medium">Your agents</p>
            <p className="text-gray-600 dark:text-gray-400" data-testid="encryption-key-state">
              {automationOn
                ? `Your agents can run until ${whenText(status.automationUntil)}. Signing in extends this.`
                : 'Your agents are paused until your next sign-in.'}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-gray-600 dark:text-gray-400" htmlFor="automation-days">
                Let them run for
              </label>
              <select
                id="automation-days"
                className="rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-gray-700 dark:bg-gray-900"
                value={status.automationDays}
                disabled={busy || deviceHasKey === false}
                onChange={(event) => void setWindow(Number(event.target.value))}
              >
                {AUTOMATION_WINDOW_DAYS.map((days) => (
                  <option key={days} value={days}>
                    {days} days after each sign-in
                  </option>
                ))}
              </select>
              {automationOn ? (
                <button
                  type="button"
                  className={button}
                  disabled={busy}
                  data-testid="encryption-key-pause"
                  onClick={() => void pauseAutomation()}
                >
                  Pause my agents now
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-4 space-y-1 text-sm" data-testid="encryption-key-device">
            <p className="font-medium">This device</p>
            {deviceHasKey === null ? (
              <p className="text-gray-600 dark:text-gray-400">Checking…</p>
            ) : deviceHasKey ? (
              <p className="text-gray-600 dark:text-gray-400">
                This browser holds your key and connects it to each session.{' '}
                <button type="button" className="underline" onClick={() => void forget()}>
                  Forget this device
                </button>
              </p>
            ) : (
              <p className="text-gray-600 dark:text-gray-400">
                This browser does not hold your key. The banner at the top of the page adds it.
              </p>
            )}
          </div>

          <div className="mt-4 space-y-2 text-sm" data-testid="encryption-key-rotate">
            <p className="font-medium">A new key</p>
            <p className="text-gray-600 dark:text-gray-400">
              Replaces your key with a fresh one, shown once. Your shares and connections stay as
              they are; every other device will need the new key.
            </p>
            {confirmRotate ? (
              <div className="flex gap-2">
                <button
                  type="button"
                  className={primary}
                  disabled={busy || deviceHasKey !== true}
                  data-testid="encryption-key-rotate-confirm"
                  onClick={() => void rotate()}
                >
                  Yes, replace my key
                </button>
                <button type="button" className={button} onClick={() => setConfirmRotate(false)}>
                  Keep it
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={button}
                disabled={busy || deviceHasKey !== true}
                data-testid="encryption-key-rotate-start"
                onClick={() => setConfirmRotate(true)}
              >
                Replace my key
              </button>
            )}
          </div>

          {status.pendingDevices.length > 0 ? (
            <div className="mt-4 space-y-2 text-sm" data-testid="encryption-key-devices">
              <p className="font-medium">Devices asking for your key</p>
              {status.pendingDevices.map((request) => (
                <div key={request.id} className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-gray-100 px-2 py-0.5 font-mono text-base tracking-widest dark:bg-gray-800">
                    {request.code}
                  </code>
                  <button
                    type="button"
                    className={primary}
                    disabled={busy || deviceHasKey !== true}
                    onClick={() => void decide(request.id, true)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className={button}
                    disabled={busy}
                    onClick={() => void decide(request.id, false)}
                  >
                    Deny
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}

      {revealed ? (
        <div
          className="mt-4 space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950"
          data-testid="encryption-key-revealed"
        >
          <p className="font-medium">Your new key — write it down now. It is not shown again.</p>
          <p
            className="select-all font-mono leading-7 break-words"
            data-testid="encryption-key-revealed-text"
          >
            {revealed}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={button}
              onClick={() => void navigator.clipboard?.writeText(revealed)}
            >
              Copy
            </button>
            <button type="button" className={primary} onClick={() => void confirmRevealed()}>
              I have written it down
            </button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <p
          className="mt-3 text-xs text-gray-600 dark:text-gray-400"
          data-testid="encryption-key-notice"
        >
          {notice}
        </p>
      ) : null}
      {failure ? (
        <p className="mt-3 text-xs text-red-600 dark:text-red-400" role="alert">
          {failure}
        </p>
      ) : null}
    </section>
  );
}
