'use client';

import { useEffect, useState, type ReactNode } from 'react';
// The PURE half of the package, not its index: the index reaches the
// database, and a client component that pulls it in drags `pg` — and then
// `dns` — into the browser bundle. That split is what prefs.ts is for.
import {
  deliveryForCategory,
  type NotificationPrefs,
  type DeliveryPrefs,
  type ToastCorner,
} from '@renkei/user-prefs/prefs';
import ConnectorIcon from '@/components/connector-icon';
import {
  getDesktopNotificationsEnabled,
  setDesktopNotificationsEnabled,
} from '@/lib/desktop-notifications-storage';
import {
  enableDesktopNotifications,
  disableDesktopNotifications,
  ensurePushSubscription,
} from '@/lib/push-subscription';

/**
 * What to be told about, and where.
 *
 * ## Three channels, not one
 *
 * Everything used to have one switch: on in the app, or nothing. Now an
 * event can reach someone in the app, by Outlook email, or by a WebEx
 * message — three independent booleans wherever a choice makes sense.
 * Outlook and WebEx both start OFF for everyone and stay that way until
 * turned on by hand; nobody is opted into a new inbox arrival by a
 * migration.
 *
 * ## Approvals and questions are not really optional
 *
 * A run pauses behind that card — it is not news, it is the thing the run
 * is waiting on — so the App column for these two rows is a fixed "Always"
 * rather than a checkbox. Only Outlook and WebEx are a real choice: "also
 * page me while it waits."
 *
 * ## Category, not per-act, for "things your agents do"
 *
 * A version of this page once offered a checkbox per ACT — "Commented on
 * an issue", "Attached a file" — which was fine for one channel and one
 * connector's worth of acts on screen at once. Multiplied by three
 * channels and summed across eleven connectors it stopped being something
 * a person could scan, let alone decide. What survives per-act is the App
 * column, since that already existed and nobody asked for it to get
 * coarser; Outlook and WebEx step back to the CATEGORY every act already
 * belongs to (created / sent / updated / deleted / scheduled, plus the
 * "anything else" catch-all) — five or six rows per connector instead of
 * dozens.
 *
 * ## Connector-gated, not just preference-gated
 *
 * Outlook and WebEx only work when there is a personal grant behind them
 * with the right permission (Mail.Send; spark:messages_write and its
 * friends for a WebEx note). `channels` carries that from the server —
 * decrypting nothing, just the plaintext granted-scopes column — so an
 * unusable checkbox reads as unusable, with a link to go connect it,
 * rather than a preference that silently never fires.
 *
 * ## What is stored
 *
 * `prefs.acts[connector][category]` is a `{app, email, webex}` triple. An
 * explicit choice is stored even when it matches the default: the default
 * can change, and somebody who chose should not be quietly moved when it
 * does.
 *
 * ## The one thing this page MUST say out loud
 *
 * Preferences apply when a notification is WRITTEN, so switching
 * something on is not retroactive. Without that sentence the first person
 * to flip a switch and find yesterday still empty reads it as a bug.
 */

/** Both corners, typed without an assertion. */
const TOAST_CORNERS: readonly ToastCorner[] = ['bottom-left', 'bottom-right'];

interface ConnectorRow {
  key: string;
  label: string;
  categories: string[];
}

interface ChannelAvailability {
  outlook: boolean;
  webex: boolean;
}

const CATEGORY_LABEL: Record<string, string> = {
  created: 'Creates something',
  sent: 'Sends something',
  updated: 'Updates something',
  deleted: 'Deletes something',
  scheduled: 'Schedules something',
  other: 'Anything else',
};

const CATEGORY_HINT: Record<string, string> = {
  other: 'No specific wording yet — off to start with, like today.',
};

/** A locked "this is always on" pill, for the App column of a pause row. */
function AlwaysPill(): ReactNode {
  return (
    <span
      title="A waiting run needs this card — it can't be turned off here."
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-semibold text-blue-800 dark:bg-blue-950 dark:text-blue-300"
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5}>
        <path d="M6 12l4 4 8-8" />
      </svg>
      Always
    </span>
  );
}

/** The line under a table explaining why Outlook/WebEx are greyed out. */
function ChannelHints({
  channels,
  slug,
}: {
  channels: ChannelAvailability;
  slug: string;
}): ReactNode {
  const missing: { label: string; anchor: string }[] = [];
  if (!channels.outlook) missing.push({ label: 'Outlook', anchor: 'microsoft' });
  if (!channels.webex) missing.push({ label: 'WebEx', anchor: 'webex' });
  if (missing.length === 0) return null;
  return (
    <div className="space-y-1 border-t border-gray-100 px-4 py-2.5 text-xs text-gray-500 dark:border-gray-900 dark:text-gray-400">
      {missing.map((channel) => (
        <p key={channel.label} className="flex flex-wrap items-center gap-1.5">
          <span>{`${channel.label} isn’t connected with permission to send, so its boxes stay off.`}</span>
          <a
            href={`/${slug}/connectors#${channel.anchor}`}
            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            {`Connect ${channel.label} →`}
          </a>
        </p>
      ))}
    </div>
  );
}

export default function PreferencesForm({
  tenantId,
  slug,
  connectors,
  channels,
  initial,
}: {
  tenantId: string;
  slug: string;
  connectors: ConnectorRow[];
  channels: ChannelAvailability;
  initial: NotificationPrefs;
}) {
  const [prefs, setPrefs] = useState<NotificationPrefs>(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');

  /*
    The browser's side of the desktop-notification deal, and the person's —
    both read in an effect, not during render: this component is
    server-rendered first, where neither `Notification` nor `localStorage`
    exists, and guessing would only trade a crash for a hydration mismatch.
    Until the effect runs the card renders in its supported shape — the
    flash is one frame, and only on browsers where the pessimistic shape
    would have been wrong anyway.

    The opt-in itself lives in THIS browser's localStorage rather than the
    synced `prefs` object: `Notification.permission` is per-browser, so a
    database row could never be more than a claim about a device it isn't
    running on. Reading it here means this switch shows what this browser
    actually has, not what some other one decided.

    'unsupported' covers the browsers with no Notification global at all —
    iOS Safari outside an installed web app being the one people will
    actually meet.
  */
  const [desktopEnabled, setDesktopEnabled] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported' | null>(null);
  // A distinct third failure mode from 'denied': the browser said yes but
  // telling the server about the subscription didn't work — a network
  // blip, or push not configured server-side. Worth its own sentence,
  // since "allow notifications" is not the fix for it.
  const [subscribeError, setSubscribeError] = useState(false);
  useEffect(() => {
    setDesktopEnabled(getDesktopNotificationsEnabled(tenantId));
    setPermission('Notification' in window ? Notification.permission : 'unsupported');
  }, [tenantId]);

  /*
    Flipping the switch ON is the moment permission is normally asked for,
    and — the part `Notification.requestPermission()` alone doesn't cover —
    the moment this device actually subscribes and tells the server. If the
    person declines the browser's prompt, or the subscribe call fails, the
    switch stays off: storing "on" for something that can never fire would
    look exactly like a bug.
  */
  async function toggleDesktop(on: boolean) {
    if (!on) {
      setDesktopEnabled(false);
      setSubscribeError(false);
      setDesktopNotificationsEnabled(tenantId, false);
      void disableDesktopNotifications(tenantId);
      return;
    }

    const outcome = await enableDesktopNotifications(tenantId);
    setPermission(
      outcome === 'unsupported' ? 'unsupported' : outcome === 'denied' ? 'denied' : 'granted'
    );
    setSubscribeError(outcome === 'subscribe-failed');
    const enabled = outcome === 'granted';
    setDesktopEnabled(enabled);
    setDesktopNotificationsEnabled(tenantId, enabled);
  }

  /**
   * The retrigger next to the switch: for when the switch already reads on
   * but the browser's own answer has drifted back to "ask" — reset from
   * site settings, most likely — so nothing has actually been firing.
   * Distinct from `toggleDesktop` because unchecking and rechecking the box
   * is not obviously how you'd fix that, and the box never changes here.
   */
  async function retryPermission() {
    if (Notification.permission === 'default') {
      let current: NotificationPermission;
      try {
        current = await Notification.requestPermission();
      } catch {
        current = 'denied';
      }
      setPermission(current);
      if (current !== 'granted') return;
    }
    setSubscribeError(!(await ensurePushSubscription(tenantId)));
  }

  function update(next: NotificationPrefs) {
    setPrefs(next);
    setStatus('idle');
  }

  /** One category's delivery, all three channels, changed at once. */
  function setCategory(connector: string, category: string, next: DeliveryPrefs) {
    const forConnector = { ...(prefs.acts[connector] ?? {}), [category]: next };
    update({ ...prefs, acts: { ...prefs.acts, [connector]: forConnector } });
  }

  /** One channel within one category, the other two left exactly as they are. */
  function setCategoryChannel(
    connector: string,
    category: string,
    channel: keyof DeliveryPrefs,
    on: boolean
  ) {
    const current = deliveryForCategory(prefs, connector, category);
    setCategory(connector, category, { ...current, [channel]: on });
  }

  function setWholeConnector(row: ConnectorRow, channel: keyof DeliveryPrefs, on: boolean) {
    const forConnector = { ...(prefs.acts[row.key] ?? {}) };
    for (const category of row.categories) {
      const current = deliveryForCategory(prefs, row.key, category);
      forConnector[category] = { ...current, [channel]: on };
    }
    update({ ...prefs, acts: { ...prefs.acts, [row.key]: forConnector } });
  }

  function setPauseChannel(
    event: 'approvalNeeded' | 'questionAsked',
    channel: 'email' | 'webex',
    on: boolean
  ) {
    update({ ...prefs, [event]: { ...prefs[event], [channel]: on } });
  }

  function setRunFailedChannel(channel: keyof DeliveryPrefs, on: boolean) {
    update({ ...prefs, runFailed: { ...prefs.runFailed, [channel]: on } });
  }

  /** Curated rows only, App channel — the summary a collapsed connector shows. */
  const appOnCount = (row: ConnectorRow) =>
    row.categories.filter((category) => deliveryForCategory(prefs, row.key, category).app).length;
  const anyExtraChannel = (row: ConnectorRow) =>
    row.categories.some((category) => {
      const d = deliveryForCategory(prefs, row.key, category);
      return d.email || d.webex;
    });

  async function save() {
    setStatus('saving');
    try {
      const response = await fetch(`/api/tenant/${tenantId}/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notifications: prefs }),
      });
      setStatus(response.ok ? 'saved' : 'failed');
    } catch {
      setStatus('failed');
    }
  }

  return (
    <div className="space-y-6">
      {/*
        One named group, not three loose cards. `aria-labelledby` makes the
        grouping real for a screen reader rather than a visual accident of
        where the rule sits.
      */}
      <section aria-labelledby="notifications-heading" className="space-y-3">
        <div className="border-b border-gray-200 pb-2 dark:border-gray-800">
          <h2 id="notifications-heading" className="text-lg font-semibold">
            Notifications
          </h2>
          <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
            What Renkei tells you about, and how it reaches you. Everything below feeds the
            notifications page.
          </p>
        </div>

        <section className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <div className="p-4 pb-3">
            <h3 className="font-semibold">Runs</h3>
            <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
              When an agent of yours starts and stops — and when someone you shared one with
              changes it.
            </p>
          </div>
          {/* Side by side once there is room, so this does not occupy a
              third of the page to say very little. */}
          <div className="@container px-4">
            <div className="grid grid-cols-1 gap-x-6 gap-y-2 @xl:grid-cols-3">
              {(
                [
                  ['runStarted', 'A run starts', 'Frequent, and rarely the interesting part.'],
                  ['runFinished', 'A run finishes', null],
                  [
                    'agentEditedByOthers',
                    'Someone edits a shared agent of yours',
                    'People you granted access to; edits land in the audit trail either way.',
                  ],
                ] as const
              ).map(([key, label, hint]) => (
                <label key={key} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 shrink-0"
                    checked={prefs[key]}
                    onChange={(event) => update({ ...prefs, [key]: event.target.checked })}
                  />
                  <span className="min-w-0">
                    {label}
                    {hint ? (
                      <span className="block text-xs text-gray-500 dark:text-gray-400">{hint}</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/*
            "A run fails" alone gets a channel row: it is the one run event
            with an actual email/WebEx sender behind it (the interactive
            worker's failure notifier), so it is the one that can honestly
            offer those columns. The other three stay plain checkboxes above
            rather than gain inert Outlook/WebEx boxes nothing would ever
            send for.
          */}
          <div className="mt-3 overflow-x-auto border-t border-gray-200 dark:border-gray-800">
            <table className="w-full min-w-[420px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs font-medium text-gray-500 dark:border-gray-800 dark:text-gray-400">
                  <th className="px-4 py-2 font-medium">When…</th>
                  <th className="w-20 px-2 py-2 text-center font-medium">App</th>
                  <th className="w-20 px-2 py-2 text-center font-medium">Outlook</th>
                  <th className="w-20 px-2 py-2 text-center font-medium">WebEx</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="px-4 py-3 align-top">
                    <span className="font-medium">A run fails</span>
                  </td>
                  <td className="px-2 py-3 text-center align-top">
                    <input
                      type="checkbox"
                      aria-label="A run fails — App"
                      checked={prefs.runFailed.app}
                      onChange={(event) => setRunFailedChannel('app', event.target.checked)}
                    />
                  </td>
                  <td className="px-2 py-3 text-center align-top">
                    <input
                      type="checkbox"
                      aria-label="A run fails — Outlook"
                      checked={channels.outlook && prefs.runFailed.email}
                      disabled={!channels.outlook}
                      onChange={(event) => setRunFailedChannel('email', event.target.checked)}
                    />
                  </td>
                  <td className="px-2 py-3 text-center align-top">
                    <input
                      type="checkbox"
                      aria-label="A run fails — WebEx"
                      checked={channels.webex && prefs.runFailed.webex}
                      disabled={!channels.webex}
                      onChange={(event) => setRunFailedChannel('webex', event.target.checked)}
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <ChannelHints channels={channels} slug={slug} />
        </section>

        <section className="rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          <div className="p-4 pb-3">
            <h3 className="font-semibold">Approvals &amp; questions</h3>
            <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
              A run pauses until you decide — the card in Renkei is always on. Choose whether it
              also pages you by Outlook or WebEx while it waits.
            </p>
          </div>
          <div className="overflow-x-auto border-t border-gray-200 dark:border-gray-800">
            <table className="w-full min-w-[420px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs font-medium text-gray-500 dark:border-gray-800 dark:text-gray-400">
                  <th className="px-4 py-2 font-medium">When…</th>
                  <th className="w-20 px-2 py-2 text-center font-medium">App</th>
                  <th className="w-20 px-2 py-2 text-center font-medium">Outlook</th>
                  <th className="w-20 px-2 py-2 text-center font-medium">WebEx</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    [
                      'approvalNeeded' as const,
                      'An agent needs your approval',
                      'Something it wants to do needs a yes or no from you.',
                    ],
                    [
                      'questionAsked' as const,
                      'An agent has a question for you',
                      'It hit a fork it can’t resolve on its own.',
                    ],
                  ] as const
                ).map(([event, label, hint]) => (
                  <tr key={event} className="border-t border-gray-100 first:border-t-0 dark:border-gray-900">
                    <td className="px-4 py-3 align-top">
                      <span className="font-medium">{label}</span>
                      <span className="block text-xs text-gray-500 dark:text-gray-400">{hint}</span>
                    </td>
                    <td className="px-2 py-3 text-center align-top">
                      <AlwaysPill />
                    </td>
                    <td className="px-2 py-3 text-center align-top">
                      <input
                        type="checkbox"
                        aria-label={`${label} — Outlook`}
                        checked={channels.outlook && prefs[event].email}
                        disabled={!channels.outlook}
                        onChange={(ev) => setPauseChannel(event, 'email', ev.target.checked)}
                      />
                    </td>
                    <td className="px-2 py-3 text-center align-top">
                      <input
                        type="checkbox"
                        aria-label={`${label} — WebEx`}
                        checked={channels.webex && prefs[event].webex}
                        disabled={!channels.webex}
                        onChange={(ev) => setPauseChannel(event, 'webex', ev.target.checked)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ChannelHints channels={channels} slug={slug} />
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          <h3 className="font-semibold">Things your agents do</h3>
          <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
            Only actions that change something are ever offered here — reading is never announced.
            Open a connector to choose which of its kinds of actions you hear about, and where.
          </p>

          <div className="mt-3 space-y-1.5">
            {connectors.map((row) => {
              const on = appOnCount(row);
              return (
                <details
                  key={row.key}
                  className="rounded-lg border border-gray-200 dark:border-gray-800"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm">
                    <ConnectorIcon capabilityKey={row.key} label={row.label} size={16} />
                    <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
                    <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                      {on} of {row.categories.length} in-app
                      {anyExtraChannel(row) ? ', plus Outlook/WebEx' : ''}
                    </span>
                    <span aria-hidden="true" className="shrink-0 text-gray-400">
                      ▾
                    </span>
                  </summary>

                  <div className="border-t border-gray-200 dark:border-gray-800">
                    <div className="flex items-center gap-3 px-3 pt-3 text-xs">
                      <span className="text-gray-500 dark:text-gray-400">App:</span>
                      <button
                        type="button"
                        onClick={() => setWholeConnector(row, 'app', true)}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={() => setWholeConnector(row, 'app', false)}
                        className="text-gray-500 hover:underline"
                      >
                        Select none
                      </button>
                    </div>

                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[420px] border-collapse text-sm">
                        <thead>
                          <tr className="text-left text-xs font-medium text-gray-500 dark:text-gray-400">
                            <th className="px-3 py-2 font-medium">Also page me when {row.label}…</th>
                            <th className="w-20 px-2 py-2 text-center font-medium">App</th>
                            <th className="w-20 px-2 py-2 text-center font-medium">Outlook</th>
                            <th className="w-20 px-2 py-2 text-center font-medium">WebEx</th>
                          </tr>
                        </thead>
                        <tbody>
                          {row.categories.map((category) => {
                            const delivery = deliveryForCategory(prefs, row.key, category);
                            return (
                              <tr
                                key={category}
                                className="border-t border-gray-100 dark:border-gray-900"
                              >
                                <td className="px-3 py-2 align-top">
                                  <span>{CATEGORY_LABEL[category] ?? category}</span>
                                  {CATEGORY_HINT[category] ? (
                                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                                      {CATEGORY_HINT[category]}
                                    </span>
                                  ) : null}
                                </td>
                                <td className="px-2 py-2 text-center align-top">
                                  <input
                                    type="checkbox"
                                    aria-label={`${row.label} ${CATEGORY_LABEL[category] ?? category} — App`}
                                    checked={delivery.app}
                                    onChange={(ev) =>
                                      setCategoryChannel(row.key, category, 'app', ev.target.checked)
                                    }
                                  />
                                </td>
                                <td className="px-2 py-2 text-center align-top">
                                  <input
                                    type="checkbox"
                                    aria-label={`${row.label} ${CATEGORY_LABEL[category] ?? category} — Outlook`}
                                    checked={channels.outlook && delivery.email}
                                    disabled={!channels.outlook}
                                    onChange={(ev) =>
                                      setCategoryChannel(row.key, category, 'email', ev.target.checked)
                                    }
                                  />
                                </td>
                                <td className="px-2 py-2 text-center align-top">
                                  <input
                                    type="checkbox"
                                    aria-label={`${row.label} ${CATEGORY_LABEL[category] ?? category} — WebEx`}
                                    checked={channels.webex && delivery.webex}
                                    disabled={!channels.webex}
                                    onChange={(ev) =>
                                      setCategoryChannel(row.key, category, 'webex', ev.target.checked)
                                    }
                                  />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </details>
              );
            })}
          </div>

          <ChannelHints channels={channels} slug={slug} />
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          <h3 className="font-semibold">Pop-ups</h3>
          <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
            The cards that appear in a corner while you are using Renkei. Turning them off does not
            affect the notifications page.
          </p>
          {/* Two small controls: side by side once there is room. The corner
              choice means nothing with pop-ups off, so it stays disabled
              rather than being hidden — a control that vanishes reads as a
              bug, where a greyed one explains itself. */}
          <div className="@container mt-3">
            <div className="grid grid-cols-1 gap-x-6 gap-y-3 @xl:grid-cols-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="shrink-0"
                  checked={prefs.toastsEnabled}
                  onChange={(event) => update({ ...prefs, toastsEnabled: event.target.checked })}
                />
                Show pop-ups
              </label>
              <fieldset disabled={!prefs.toastsEnabled} className="min-w-0">
                <legend className="text-sm font-medium">Corner</legend>
                <div className="mt-1 flex flex-wrap gap-4">
                  {TOAST_CORNERS.map((corner) => (
                    <label key={corner} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="toastCorner"
                        className="shrink-0"
                        checked={prefs.toastCorner === corner}
                        onChange={() => update({ ...prefs, toastCorner: corner })}
                      />
                      {corner === 'bottom-left' ? 'Bottom left' : 'Bottom right'}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          <h3 className="font-semibold">Browser notifications</h3>
          <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
            The other half of pop-ups: your system&rsquo;s own notifications, shown when Renkei is
            open in a background tab. Nothing fires while you are looking at Renkei — that is what
            the pop-ups are for. Remembered by this browser only, not your account — sign in
            somewhere else and it starts off there too.
          </p>
          <div className="mt-3 flex flex-wrap items-start gap-x-3 gap-y-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 shrink-0"
                checked={desktopEnabled}
                disabled={permission === 'unsupported'}
                onChange={(event) => void toggleDesktop(event.target.checked)}
              />
              <span className="min-w-0">
                Show system notifications
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  Your browser asks its own permission the first time — both switches have to be on.
                </span>
              </span>
            </label>
            {/*
              The switch already reads on, but the browser's own answer has
              drifted back to "ask" — a site-settings reset is the usual
              cause. Unchecking and rechecking the box would not fix this
              (it would just turn the preference off), so this is a
              separate control that re-asks without touching it.
            */}
            {desktopEnabled && permission === 'default' ? (
              <button
                type="button"
                onClick={() => void retryPermission()}
                className="shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700"
              >
                Allow notifications
              </button>
            ) : null}
            {/*
              The states worth a sentence, not every state: 'granted' needs
              nothing beyond the hint above, and null (one server-rendered
              frame) must claim nothing it cannot know yet.
            */}
            {permission === 'unsupported' ? (
              <p className="w-full text-xs text-gray-500 dark:text-gray-400">
                This browser can&rsquo;t show them. On iPhone and iPad they only work once Renkei is
                added to the Home Screen.
              </p>
            ) : null}
            {permission === 'denied' ? (
              <p className="w-full text-xs text-amber-700 dark:text-amber-400">
                Blocked for this site in your browser&rsquo;s settings, which is why nothing shows
                up even with this switch on: once a browser has recorded &ldquo;block&rdquo;, it
                won&rsquo;t ask again on its own, so Renkei can&rsquo;t re-prompt for you. Open this
                page&rsquo;s site settings (usually behind the padlock or the icon left of the
                address bar), allow notifications, then reload.
              </p>
            ) : null}
            {subscribeError ? (
              <p className="w-full text-xs text-amber-700 dark:text-amber-400">
                Your browser allowed it, but telling Renkei&rsquo;s server about this device
                didn&rsquo;t work — a connection hiccup, most likely. Try the switch again in a
                moment.
              </p>
            ) : null}
          </div>
        </section>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={status === 'saving'}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {status === 'saved' ? <span className="text-sm text-green-700">Saved.</span> : null}
        {status === 'failed' ? (
          <span className="text-sm text-red-600 dark:text-red-400">Could not save.</span>
        ) : null}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          These apply from now on. Switching something on does not fill in what already happened.
        </p>
      </div>
    </div>
  );
}
