'use client';

/**
 * The browser's keeper of the person's encryption key
 * (docs/delegate-key-design.md). Mounted on every tenant page; it reads
 * GET /api/tenant/[tenantId]/keys and does whatever the moment needs, with
 * as little ceremony as the design allows:
 *
 *   - not enrolled           → enroll now, silently, and keep the key on
 *                              this device; then a banner asks the person
 *                              to write the key down (the reveal stays in
 *                              Preferences until they confirm);
 *   - enrolled, key here     → seal fresh delegations whenever a live
 *                              instance lacks this session's (sign-in, a
 *                              delegate restart), renewing the automation
 *                              window; answer other devices' asks;
 *   - enrolled, key elsewhere→ a banner: type the key, or approve from a
 *                              device that holds it;
 *   - a pre-enrollment key on a passphrase → the passphrase once, then
 *                              enrollment moves everything.
 *
 * It checks on mount, when the tab regains focus, and every minute, and
 * refreshes the page's server data after it changes anything, so a chat
 * that read as "key not connected" comes back without a reload.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { KeyStatusView } from '@/lib/keys/shared';
import {
  acknowledgeKey,
  keyAcknowledged,
  loadUserKey,
  saveUserKey,
} from '@/lib/keys/browser/device-store';
import {
  adoptKeyInBrowser,
  approveDeviceAsk,
  askOtherDevices,
  delegateInBrowser,
  denyDeviceAsk,
  enrollInBrowser,
  fetchKeyStatus,
  parseTypedKey,
  pollDeviceAsk,
  type DeviceAsk,
} from '@/lib/keys/browser/flows';
import { formatUserKey } from '@renkei/crypto/browser';
import Modal from './modal';

const CHECK_MS = 60_000;
const ASK_POLL_MS = 3_000;

type Banner =
  | { kind: 'none' }
  | { kind: 'write-down'; shown: string }
  | { kind: 'needs-key' }
  | { kind: 'passphrase' }
  | { kind: 'approve'; requests: { id: string; code: string }[] }
  | { kind: 'unavailable' };

export default function KeyGuard({ tenantId, slug }: { tenantId: string; slug: string }) {
  const router = useRouter();
  const [banner, setBanner] = useState<Banner>({ kind: 'none' });
  const [dialog, setDialog] = useState<'reveal' | 'unlock' | 'passphrase' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [ask, setAsk] = useState<DeviceAsk | null>(null);
  const statusRef = useRef<KeyStatusView | null>(null);
  const checking = useRef(false);

  /**
   * The key just became available to the delegate. A page that rendered
   * its content as unavailable keeps that in client state (the chat
   * thread holds its messages), so a server refresh is not enough there:
   * reload it. Anywhere else, refreshing the server data is.
   */
  const settle = useCallback(() => {
    if (document.querySelector('[data-testid="chat-key-unavailable-notice"]')) {
      window.location.reload();
      return;
    }
    router.refresh();
  }, [router]);

  const check = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      const status = await fetchKeyStatus(tenantId);
      statusRef.current = status;
      if (!status || status.unavailable) {
        setBanner((current) => (current.kind === 'write-down' ? current : { kind: 'unavailable' }));
        return;
      }
      const deviceKey = await loadUserKey(tenantId);
      if (!status.enrolled) {
        if (status.legacy && status.legacyNeedsPassphrase) {
          setBanner({ kind: 'passphrase' });
          return;
        }
        const enrolled = await enrollInBrowser(tenantId, status, {
          automationDays: status.automationDays,
        });
        if (!enrolled.ok) {
          setFailure(enrolled.failure.error);
          setBanner({ kind: 'unavailable' });
          return;
        }
        setBanner({ kind: 'write-down', shown: enrolled.outcome.shown });
        settle();
        return;
      }
      if (deviceKey) {
        if (!status.sessionDelegated) {
          const delegated = await delegateInBrowser(tenantId, status, deviceKey, {
            automationDays: status.automationDays,
          });
          if (delegated.ok) settle();
          else if (delegated.failure.code === 'wrong_key') {
            // The key on this device is not this account's any more (a rotation elsewhere).
            setBanner({ kind: 'needs-key' });
            return;
          }
        } else if (
          status.automationUntil &&
          new Date(status.automationUntil).getTime() - Date.now() <
            (status.automationDays * 24 * 60 * 60_000) / 2
        ) {
          // Signing in extends the window (decision 4): renew when half of it has passed.
          void delegateInBrowser(tenantId, status, deviceKey, {
            automationDays: status.automationDays,
          });
        }
        if (status.pendingDevices.length > 0) {
          setBanner({ kind: 'approve', requests: status.pendingDevices });
          return;
        }
        if (!(await keyAcknowledged(tenantId))) {
          setBanner({ kind: 'write-down', shown: formatUserKey(deviceKey) });
          return;
        }
        setBanner({ kind: 'none' });
        return;
      }
      // Enrolled, and this device has no key. Fine while this session is
      // delegated (another browser did it); otherwise the person must bring it.
      setBanner(status.sessionDelegated ? { kind: 'none' } : { kind: 'needs-key' });
    } finally {
      checking.current = false;
    }
  }, [settle, tenantId]);

  useEffect(() => {
    void check();
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    const timer = setInterval(() => void check(), CHECK_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(timer);
    };
  }, [check]);

  // Polling an ask this device made of the person's other devices.
  useEffect(() => {
    if (!ask) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        const answer = await pollDeviceAsk(tenantId, ask);
        if (cancelled || answer === null) return;
        if (answer === 'expired' || answer === 'gone') {
          setAsk(null);
          setFailure(
            answer === 'expired' ? 'The request expired; ask again.' : 'The request was declined.'
          );
          return;
        }
        const status = statusRef.current;
        if (!status) return;
        const adopted = await adoptKeyInBrowser(tenantId, status, answer);
        setAsk(null);
        if (!adopted.ok) {
          setFailure(adopted.failure.error);
          return;
        }
        await saveUserKey(tenantId, answer, { acknowledged: true });
        setDialog(null);
        setBanner({ kind: 'none' });
        settle();
      })();
    }, ASK_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ask, settle, tenantId]);

  async function submitTypedKey(): Promise<void> {
    const status = statusRef.current;
    if (!status) return;
    const parsed = parseTypedKey(typed);
    if (!parsed.ok) {
      setFailure(parsed.error);
      return;
    }
    setBusy(true);
    setFailure(null);
    const adopted = await adoptKeyInBrowser(tenantId, status, parsed.bytes);
    setBusy(false);
    if (!adopted.ok) {
      setFailure(adopted.failure.error);
      return;
    }
    setTyped('');
    setDialog(null);
    setBanner({ kind: 'none' });
    settle();
  }

  async function startAsk(): Promise<void> {
    setFailure(null);
    const started = await askOtherDevices(tenantId);
    if (!started.ok) {
      setFailure(started.failure.error);
      return;
    }
    setAsk(started.ask);
  }

  async function submitPassphrase(): Promise<void> {
    const status = statusRef.current;
    if (!status) return;
    setBusy(true);
    setFailure(null);
    const enrolled = await enrollInBrowser(tenantId, status, {
      passphrase,
      automationDays: status.automationDays,
    });
    setBusy(false);
    if (!enrolled.ok) {
      setFailure(enrolled.failure.error);
      return;
    }
    setPassphrase('');
    setDialog('reveal');
    setBanner({ kind: 'write-down', shown: enrolled.outcome.shown });
    settle();
  }

  async function decideAsk(requestId: string, approve: boolean): Promise<void> {
    setBusy(true);
    setFailure(null);
    if (approve) {
      const deviceKey = await loadUserKey(tenantId);
      if (deviceKey) {
        const approved = await approveDeviceAsk(tenantId, requestId, deviceKey);
        if (!approved.ok) setFailure(approved.failure.error);
      }
    } else {
      await denyDeviceAsk(tenantId, requestId);
    }
    setBusy(false);
    await check();
  }

  async function confirmWrittenDown(): Promise<void> {
    await acknowledgeKey(tenantId);
    setDialog(null);
    setBanner({ kind: 'none' });
  }

  const bannerClass =
    'flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100';
  const buttonClass =
    'rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';
  const quietButtonClass =
    'rounded-md border border-gray-300 px-3 py-1 text-sm hover:bg-white/50 disabled:opacity-50 dark:border-gray-600';

  return (
    <>
      {banner.kind === 'write-down' ? (
        <div className={bannerClass} role="status" data-testid="key-banner-write-down">
          <span>
            <span className="font-medium">Your encryption key is ready.</span> Write it down: it is
            the only way back into your chats on a device that does not have it.
          </span>
          <button type="button" className={buttonClass} onClick={() => setDialog('reveal')}>
            Show my key
          </button>
        </div>
      ) : null}
      {banner.kind === 'needs-key' ? (
        <div className={bannerClass} role="status" data-testid="key-banner-needs-key">
          <span>
            <span className="font-medium">This device does not have your encryption key.</span> Your
            chats and connectors stay closed here until it does.
          </span>
          <button type="button" className={buttonClass} onClick={() => setDialog('unlock')}>
            Add my key
          </button>
        </div>
      ) : null}
      {banner.kind === 'passphrase' ? (
        <div className={bannerClass} role="status" data-testid="key-banner-passphrase">
          <span>
            <span className="font-medium">Finish setting up your encryption key.</span> Your earlier
            key was passphrase-protected; enter it once to move your data to the new key.
          </span>
          <button type="button" className={buttonClass} onClick={() => setDialog('passphrase')}>
            Continue
          </button>
        </div>
      ) : null}
      {banner.kind === 'approve' ? (
        <div className={bannerClass} role="status" data-testid="key-banner-approve">
          <span>
            <span className="font-medium">Another device is asking for your encryption key.</span>{' '}
            Approve only if the code matches what that device shows.
          </span>
          {banner.requests.map((request) => (
            <span key={request.id} className="flex items-center gap-2">
              <code className="rounded bg-white/60 px-2 py-0.5 font-mono text-base tracking-widest dark:bg-black/30">
                {request.code}
              </code>
              <button
                type="button"
                className={buttonClass}
                disabled={busy}
                onClick={() => void decideAsk(request.id, true)}
              >
                Approve
              </button>
              <button
                type="button"
                className={quietButtonClass}
                disabled={busy}
                onClick={() => void decideAsk(request.id, false)}
              >
                Deny
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {banner.kind === 'unavailable' ? (
        <div className={bannerClass} role="status" data-testid="key-banner-unavailable">
          <span>
            <span className="font-medium">The key service cannot be reached.</span> Your chats and
            connectors stay closed until it is back; this page keeps trying.
            {failure ? ` (${failure})` : ''}
          </span>
        </div>
      ) : null}

      {dialog === 'reveal' && banner.kind === 'write-down' ? (
        <Modal title="Your encryption key" onClose={() => setDialog(null)}>
          <div className="space-y-3 text-sm" data-testid="key-reveal">
            <p>
              This key protects everything of yours in Renkei. Nobody else has it — not Renkei, not
              your administrator. Write it down somewhere safe. On a new device you will type it, or
              approve the device from one that already has it.
            </p>
            <p
              className="select-all rounded-md border border-gray-300 bg-gray-50 p-3 font-mono text-sm leading-7 break-words dark:border-gray-700 dark:bg-gray-900"
              data-testid="key-reveal-text"
            >
              {banner.shown}
            </p>
            <p className="text-xs text-gray-600 dark:text-gray-400">
              If every device that holds it is lost and you did not write it down, your chats and
              connections are lost with it. There is no recovery by design.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                className={buttonClass}
                onClick={() => void navigator.clipboard?.writeText(banner.shown)}
              >
                Copy
              </button>
              <button
                type="button"
                className={quietButtonClass}
                data-testid="key-reveal-confirm"
                onClick={() => void confirmWrittenDown()}
              >
                I have written it down
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {dialog === 'unlock' ? (
        <Modal title="Add your encryption key to this device" onClose={() => setDialog(null)}>
          <div className="space-y-4 text-sm" data-testid="key-unlock">
            <div className="space-y-2">
              <label className="block font-medium" htmlFor="key-typed">
                Type the key you wrote down
              </label>
              <textarea
                id="key-typed"
                className="w-full rounded-md border border-gray-300 p-2 font-mono text-sm dark:border-gray-700 dark:bg-gray-900"
                rows={3}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                placeholder="abcd-efgh-ijkl-…"
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className={buttonClass}
                disabled={busy || typed.trim().length === 0}
                data-testid="key-unlock-submit"
                onClick={() => void submitTypedKey()}
              >
                Use this key
              </button>
            </div>
            <div className="border-t border-gray-200 pt-3 dark:border-gray-800">
              <p className="mb-2 font-medium">Or approve from a device that has it</p>
              {ask ? (
                <p data-testid="key-unlock-code">
                  On that device, open Renkei and approve the request showing the code{' '}
                  <code className="rounded bg-gray-100 px-2 py-0.5 font-mono text-base tracking-widest dark:bg-gray-800">
                    {ask.code}
                  </code>
                  . This page picks the key up by itself.
                </p>
              ) : (
                <button type="button" className={quietButtonClass} onClick={() => void startAsk()}>
                  Ask my other devices
                </button>
              )}
            </div>
            {failure ? (
              <p className="text-red-600 dark:text-red-400" role="alert">
                {failure}
              </p>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {dialog === 'passphrase' ? (
        <Modal title="Move to your new encryption key" onClose={() => setDialog(null)}>
          <div className="space-y-3 text-sm">
            <p>
              Your chats and connections are under a passphrase-protected key from an earlier
              version of Renkei. Enter that passphrase once; everything moves to a key this browser
              generates and shows you next.
            </p>
            <input
              type="password"
              className="w-full rounded-md border border-gray-300 p-2 dark:border-gray-700 dark:bg-gray-900"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="current-password"
              aria-label="Passphrase"
            />
            <button
              type="button"
              className={buttonClass}
              disabled={busy || passphrase.length === 0}
              onClick={() => void submitPassphrase()}
            >
              Move my data
            </button>
            {failure ? (
              <p className="text-red-600 dark:text-red-400" role="alert">
                {failure}
              </p>
            ) : null}
          </div>
        </Modal>
      ) : null}
      <span hidden data-slug={slug} />
    </>
  );
}
