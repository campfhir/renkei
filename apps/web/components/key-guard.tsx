'use client';

/**
 * The browser's keeper of the person's encryption key
 * (docs/delegate-key-design.md). Mounted on every tenant page; it reads
 * GET /api/keys and does whatever the moment needs, with
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

import { useCallback, useEffect, useReducer, useRef } from 'react';
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
  type UnknownInstance,
} from '@/lib/keys/browser/flows';
import { formatUserKey } from '@renkei/crypto/browser';
import Modal from './modal';
import {
  approvalRechecks,
  canApprove,
  canSubmitPassphrase,
  canSubmitTypedKey,
  checkStep,
  codeFor,
  delegationStops,
  dialogOpen,
  initialKeyGuard,
  keyGuardReducer,
  statusUsable,
  type EnrollAnswer,
  type FlowAnswer,
} from './key-guard.model';

const CHECK_MS = 60_000;
const ASK_POLL_MS = 3_000;

function enrollAnswer(result: Awaited<ReturnType<typeof enrollInBrowser>>): EnrollAnswer {
  return result.ok ? { ok: true, shown: result.outcome.shown } : result;
}

export default function KeyGuard() {
  const router = useRouter();
  // The attention-demanding states open front and center as a dialog.
  // Dismissing one (the key is needed, but not for this page) leaves a
  // banner with a way back; the shown-once key cannot be dismissed, only
  // confirmed written down. The rules are key-guard.model.ts's.
  const [state, dispatch] = useReducer(keyGuardReducer, initialKeyGuard);
  const { banner, busy, failure, typed, passphrase, ask } = state;
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
      const status = await fetchKeyStatus();
      statusRef.current = status;
      if (!statusUsable(status)) {
        dispatch({ type: 'status-unavailable' });
        return;
      }
      const deviceKey = await loadUserKey();
      const step = checkStep(status, deviceKey !== null, Date.now());
      if (step.kind === 'passphrase') {
        dispatch({ type: 'passphrase-needed' });
        return;
      }
      if (step.kind === 'enroll') {
        const enrolled = await enrollInBrowser(status, {
          automationDays: status.automationDays,
        });
        dispatch({ type: 'enroll-answered', answer: enrollAnswer(enrolled) });
        if (enrolled.ok) settle();
        return;
      }
      if (step.kind === 'no-device-key' || !deviceKey) {
        dispatch({ type: 'device-without-key', sessionDelegated: status.sessionDelegated });
        return;
      }
      if (step.delegate) {
        const delegated: FlowAnswer = await delegateInBrowser(status, deviceKey, {
          automationDays: status.automationDays,
        });
        dispatch({ type: 'delegate-answered', answer: delegated });
        if (delegated.ok) settle();
        else if (delegationStops(delegated)) return;
      } else if (step.renew) {
        void delegateInBrowser(status, deviceKey, {
          automationDays: status.automationDays,
        });
      }
      const acknowledged = status.pendingDevices.length > 0 || (await keyAcknowledged());
      dispatch({
        type: 'device-checked',
        pendingDevices: status.pendingDevices,
        acknowledged,
        shown: formatUserKey(deviceKey),
      });
    } finally {
      checking.current = false;
    }
  }, [settle]);

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
        const answer = await pollDeviceAsk(ask);
        if (cancelled || answer === null) return;
        if (answer === 'expired') {
          dispatch({ type: 'ask-expired' });
          return;
        }
        if (answer === 'gone') {
          dispatch({ type: 'ask-declined' });
          return;
        }
        const status = statusRef.current;
        if (!status) return;
        const adopted = await adoptKeyInBrowser(status, answer);
        if (adopted.ok) await saveUserKey(answer, { acknowledged: true });
        dispatch({ type: 'ask-adopted', answer: adopted });
        if (adopted.ok) settle();
      })();
    }, ASK_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ask, settle]);

  async function submitTypedKey(): Promise<void> {
    const status = statusRef.current;
    if (!status) return;
    const parsed = parseTypedKey(typed);
    if (!parsed.ok) {
      dispatch({ type: 'typed-key-refused', error: parsed.error });
      return;
    }
    dispatch({ type: 'typed-key-sent' });
    const adopted = await adoptKeyInBrowser(status, parsed.bytes);
    dispatch({ type: 'typed-key-answered', answer: adopted });
    if (adopted.ok) settle();
  }

  async function startAsk(): Promise<void> {
    dispatch({ type: 'ask-requested' });
    const started = await askOtherDevices();
    if (!started.ok) {
      dispatch({ type: 'ask-refused', error: started.failure.error });
      return;
    }
    dispatch({ type: 'ask-opened', ask: started.ask });
  }

  async function submitPassphrase(): Promise<void> {
    const status = statusRef.current;
    if (!status) return;
    dispatch({ type: 'passphrase-sent' });
    const enrolled = await enrollInBrowser(status, {
      passphrase,
      automationDays: status.automationDays,
    });
    dispatch({ type: 'passphrase-answered', answer: enrollAnswer(enrolled) });
    if (enrolled.ok) settle();
  }

  async function decideAsk(requestId: string, approve: boolean): Promise<void> {
    const code = codeFor(state, requestId);
    dispatch({ type: 'decision-sent' });
    if (approve) {
      const deviceKey = await loadUserKey();
      if (deviceKey) {
        const approved = await approveDeviceAsk(requestId, code, deviceKey);
        if (!approved.ok) {
          dispatch({ type: 'approval-refused', failure: approved.failure });
          // A closed request (too many wrong codes) leaves the list on the next check.
          if (approvalRechecks(approved.failure)) await check();
          return;
        }
      }
    } else {
      await denyDeviceAsk(requestId);
    }
    dispatch({ type: 'decision-done' });
    await check();
  }

  async function confirmWrittenDown(): Promise<void> {
    await acknowledgeKey();
    dispatch({ type: 'written-down' });
  }

  /** The person compared the fingerprints and says this is their key service. */
  async function trustAndContinue(unknown: UnknownInstance[]): Promise<void> {
    const status = statusRef.current;
    if (!status) return;
    dispatch({ type: 'trust-sent' });
    await confirmInstanceTrust(status, unknown);
    dispatch({ type: 'trust-confirmed' });
    await check();
  }

  const bannerClass =
    'flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100';
  const buttonClass =
    'rounded-md bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';
  const quietButtonClass =
    'rounded-md border border-gray-300 px-3 py-1 text-sm hover:bg-white/50 disabled:opacity-50 dark:border-gray-600';
  const open = dialogOpen(state);
  const dismiss = () => dispatch({ type: 'dismissed' });
  const reopen = () => dispatch({ type: 'reopened' });

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
          onChange={(event) => dispatch({ type: 'typed-changed', value: event.target.value })}
          placeholder="abcd-efgh-ijkl-…"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          className={buttonClass}
          disabled={!canSubmitTypedKey(state)}
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
          <button type="button" className={buttonClass} onClick={reopen}>
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
              onChange={(event) =>
                dispatch({ type: 'passphrase-changed', value: event.target.value })
              }
              autoComplete="current-password"
              aria-label="Passphrase"
            />
            <button
              type="button"
              className={buttonClass}
              disabled={!canSubmitPassphrase(state)}
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
          <button type="button" className={buttonClass} onClick={reopen}>
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
                      value={codeFor(state, request.id)}
                      onChange={(event) =>
                        dispatch({
                          type: 'code-changed',
                          requestId: request.id,
                          value: event.target.value,
                        })
                      }
                      placeholder="ABCDE-FGHIJ"
                      aria-label="The code the other device shows"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className={buttonClass}
                      disabled={!canApprove(state, request.id)}
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
          <button type="button" className={buttonClass} onClick={reopen}>
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
          <button type="button" className={buttonClass} onClick={reopen}>
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
    </>
  );
}
