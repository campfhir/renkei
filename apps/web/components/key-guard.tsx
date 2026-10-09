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
import { askedAtText, describeUserAgent, type KeyStatusView } from '@/lib/keys/shared';
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
  confirmInstanceTrust,
  delegateInBrowser,
  denyDeviceAsk,
  enrollInBrowser,
  fetchKeyStatus,
  parseTypedKey,
  pollDeviceAsk,
  type DeviceAsk,
  type FlowFailure,
  type UnknownInstance,
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
  | { kind: 'approve'; requests: KeyStatusView['pendingDevices'] }
  /** A delegate instance this browser has not sealed to before: confirm its fingerprint first. */
  | { kind: 'trust'; unknown: UnknownInstance[] }
  | { kind: 'unavailable' };

export default function KeyGuard({ tenantId, slug }: { tenantId: string; slug: string }) {
  const router = useRouter();
  const [banner, setBanner] = useState<Banner>({ kind: 'none' });
  // The attention-demanding states open front and center as a dialog.
  // Dismissing one (the key is needed, but not for this page) leaves a
  // banner with a way back; the shown-once key cannot be dismissed, only
  // confirmed written down.
  const [dismissed, setDismissed] = useState<Banner['kind'] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [ask, setAsk] = useState<DeviceAsk | null>(null);
  /** What the person typed off each asking device's screen, by request id. */
  const [typedCodes, setTypedCodes] = useState<Record<string, string>>({});
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

  /** An `untrusted_instances` failure becomes the trust dialog; anything else is left to the caller. */
  const untrusted = useCallback((failure: FlowFailure): boolean => {
    if (failure.code !== 'untrusted_instances' || !failure.unknown) return false;
    setBanner({ kind: 'trust', unknown: failure.unknown });
    return true;
  }, []);

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
          if (untrusted(enrolled.failure)) return;
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
          else if (untrusted(delegated.failure)) return;
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
  }, [settle, tenantId, untrusted]);

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
      if (untrusted(adopted.failure)) return;
      setFailure(adopted.failure.error);
      return;
    }
    setTyped('');
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
    setBanner({ kind: 'write-down', shown: enrolled.outcome.shown });
    settle();
  }

  async function decideAsk(requestId: string, approve: boolean): Promise<void> {
    setBusy(true);
    setFailure(null);
    if (approve) {
      const deviceKey = await loadUserKey(tenantId);
      if (deviceKey) {
        const approved = await approveDeviceAsk(
          tenantId,
          requestId,
          typedCodes[requestId] ?? '',
          deviceKey
        );
        if (!approved.ok) {
          setFailure(approved.failure.error);
          setBusy(false);
          // A closed request (too many wrong codes) leaves the list on the next check.
          if (approved.failure.code === 'wrong_code' && !/closed/.test(approved.failure.error))
            return;
          await check();
          return;
        }
      }
    } else {
      await denyDeviceAsk(tenantId, requestId);
    }
    setBusy(false);
    await check();
  }

  async function confirmWrittenDown(): Promise<void> {
    await acknowledgeKey(tenantId);
    setBanner({ kind: 'none' });
  }

  /** The person compared the fingerprints and says this is their key service. */
  async function trustAndContinue(unknown: UnknownInstance[]): Promise<void> {
    const status = statusRef.current;
    if (!status) return;
    setBusy(true);
    await confirmInstanceTrust(tenantId, status, unknown);
    setBusy(false);
    setBanner({ kind: 'none' });
    setDismissed(null);
    await check();
  }

  const bannerClass =
    'flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100';
  const buttonClass =
    'rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';
  const quietButtonClass =
    'rounded-md border border-gray-300 px-3 py-1 text-sm hover:bg-white/50 disabled:opacity-50 dark:border-gray-600';
  const open = dismissed !== banner.kind;
  const dismiss = () => setDismissed(banner.kind);

  const unlockForm = (
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
  );

  return (
    <>
      {banner.kind === 'write-down' ? (
        <Modal title="Your encryption key is ready" onClose={() => undefined} dismissible={false}>
          <div className="space-y-3 text-sm" data-testid="key-modal-write-down">
            <p>
              <span className="font-medium">Write it down.</span> It is the only way back into your
              chats on a device that does not have it.
            </p>
            <div className="space-y-3" data-testid="key-reveal">
              <p>
                This key protects everything of yours in Renkei. Nobody else has it — not Renkei,
                not your administrator. Keep it somewhere safe. On a new device you will type it, or
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
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  className={quietButtonClass}
                  onClick={() => void navigator.clipboard?.writeText(banner.shown)}
                >
                  Copy
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  data-testid="key-reveal-confirm"
                  onClick={() => void confirmWrittenDown()}
                >
                  I have written it down
                </button>
              </div>
            </div>
          </div>
        </Modal>
      ) : null}

      {banner.kind === 'needs-key' && open ? (
        <Modal title="This device does not have your encryption key" onClose={dismiss}>
          <div className="space-y-4" data-testid="key-modal-needs-key">
            <p className="text-sm">
              Your chats and connectors stay closed here until it does. Type the key you wrote down,
              or approve this device from one that has it.
            </p>
            {unlockForm}
          </div>
        </Modal>
      ) : null}
      {banner.kind === 'needs-key' && !open ? (
        <div className={bannerClass} role="status" data-testid="key-banner-needs-key">
          <span>
            <span className="font-medium">This device does not have your encryption key.</span> Your
            chats and connectors stay closed here until it does.
          </span>
          <button type="button" className={buttonClass} onClick={() => setDismissed(null)}>
            Add my key
          </button>
        </div>
      ) : null}

      {banner.kind === 'passphrase' && open ? (
        <Modal title="Finish setting up your encryption key" onClose={dismiss}>
          <div className="space-y-3 text-sm" data-testid="key-modal-passphrase">
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
      {banner.kind === 'passphrase' && !open ? (
        <div className={bannerClass} role="status" data-testid="key-banner-passphrase">
          <span>
            <span className="font-medium">Finish setting up your encryption key.</span> Your earlier
            key was passphrase-protected; enter it once to move your data to the new key.
          </span>
          <button type="button" className={buttonClass} onClick={() => setDismissed(null)}>
            Continue
          </button>
        </div>
      ) : null}

      {banner.kind === 'approve' && open ? (
        <Modal title="Another device is asking for your encryption key" onClose={dismiss}>
          <div className="space-y-3 text-sm" data-testid="key-modal-approve">
            <p>
              Type the code that device is showing. If no device of yours is showing a code, deny
              the request: somebody else may be signed in as you.
            </p>
            <ul className="space-y-3">
              {banner.requests.map((request) => (
                <li key={request.id} className="space-y-2" data-testid="key-approve-request">
                  <p className="text-gray-600 dark:text-gray-400">
                    Asked {askedAtText(request.createdAt)} from{' '}
                    {describeUserAgent(request.userAgent)}.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="w-40 rounded-md border border-gray-300 px-2 py-1 font-mono text-base tracking-widest uppercase dark:border-gray-700 dark:bg-gray-900"
                      value={typedCodes[request.id] ?? ''}
                      onChange={(event) =>
                        setTypedCodes((current) => ({
                          ...current,
                          [request.id]: event.target.value,
                        }))
                      }
                      placeholder="ABCDE-FGHIJ"
                      aria-label="The code the other device shows"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={busy || (typedCodes[request.id] ?? '').trim().length === 0}
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
                  </div>
                </li>
              ))}
            </ul>
            {failure ? (
              <p className="text-red-600 dark:text-red-400" role="alert">
                {failure}
              </p>
            ) : null}
          </div>
        </Modal>
      ) : null}
      {banner.kind === 'approve' && !open ? (
        <div className={bannerClass} role="status" data-testid="key-banner-approve">
          <span>
            <span className="font-medium">Another device is asking for your encryption key.</span>
          </span>
          <button type="button" className={buttonClass} onClick={() => setDismissed(null)}>
            Review
          </button>
        </div>
      ) : null}

      {banner.kind === 'trust' && open ? (
        <Modal title="Is this your key service?" onClose={dismiss}>
          <div className="space-y-3 text-sm" data-testid="key-modal-trust">
            <p>
              This browser is about to hand your encryption key to a key service it has not seen
              before. Nothing is sent until you confirm. Check the fingerprint
              {banner.unknown.length > 1 ? 's' : ''} below against what your administrator published
              (the key service prints it when it starts); if nobody can vouch for it, choose Not
              now.
            </p>
            <ul className="space-y-1">
              {banner.unknown.map((instance) => (
                <li key={instance.id} data-testid="key-trust-fingerprint">
                  <code className="rounded bg-gray-100 px-2 py-1 font-mono text-base tracking-widest dark:bg-gray-800">
                    {instance.fingerprint}
                  </code>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className={buttonClass}
                disabled={busy}
                data-testid="key-trust-confirm"
                onClick={() => void trustAndContinue(banner.unknown)}
              >
                It matches, continue
              </button>
              <button type="button" className={quietButtonClass} onClick={dismiss}>
                Not now
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
      {banner.kind === 'trust' && !open ? (
        <div className={bannerClass} role="status" data-testid="key-banner-trust">
          <span>
            <span className="font-medium">Your key is not connected.</span> This browser has not
            confirmed the key service it would hand your key to.
          </span>
          <button type="button" className={buttonClass} onClick={() => setDismissed(null)}>
            Review
          </button>
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
      <span hidden data-slug={slug} />
    </>
  );
}
