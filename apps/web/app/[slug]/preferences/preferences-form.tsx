'use client';

import { useEffect, useState } from 'react';
// The PURE half of the package, not its index: the index reaches the
// database, and a client component that pulls it in drags `pg` — and then
// `dns` — into the browser bundle. That split is what prefs.ts is for.
import { wantsAct, type NotificationPrefs, type ToastCorner } from '@renkei/user-prefs/prefs';
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
 * ## Everything here is one subject, and says so
 *
 * Runs, acts and pop-ups are three faces of a single question — what
 * Renkei tells you about — but as three sibling cards under a page called
 * "Preferences" they read as three unrelated settings, and nothing on
 * screen connected "Pop-ups" to the notifications page it fills. They sit
 * under one NOTIFICATIONS heading now. It also leaves an obvious place for
 * the second group of preferences to go, whatever it turns out to be,
 * instead of it landing in the same undifferentiated stack.
 *
 * ## Why the acts are a list per connector, laid out as a grid
 *
 * The first version was a connector × category TABLE — Jira across,
 * "Created / Sent / Changed / Deleted / Scheduled" down. It looked tidy
 * and it could not be read: the Jira row offered a checkbox for
 * "Scheduled", and there is no such thing as scheduling in Jira. Most of
 * the cells were like that. A table of that shape asserts every connector
 * does every kind of thing, and connectors do not; each does its own
 * specific handful.
 *
 * So the CONTENT is a list of the acts a connector can actually perform,
 * in the words of the act — "Commented on an issue", "Accepted or
 * declined an invitation". The LAYOUT is a grid, which is a different
 * claim entirely: it says these are peers worth scanning side by side,
 * not that every column means something for every row. Jira has 39 of
 * them, and one per line is a great deal of scrolling past white space.
 *
 * The column count comes from a CONTAINER query, not the viewport. The
 * panel's width is set by the page's max-width and the card padding
 * around it, so a viewport breakpoint would be guessing at it — and would
 * guess wrong the moment either changes. This is the same fix the
 * connector scope pickers needed for the same reason.
 *
 * ## What is stored
 *
 * A curated row writes `prefs.tools[tool]`, which is the most specific
 * layer of `wantsAct` and therefore wins outright. The "anything else"
 * row per connector writes `prefs.acts[connector].other`, the middle
 * layer, covering every act with no wording yet — a hundred-odd of them,
 * which is why it starts off.
 *
 * Nothing about the stored shape changed when the grid did. A grid entry
 * saved by the old page still applies underneath, so nobody's earlier
 * choices were silently discarded by a redesign of the page that made
 * them.
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
  acts: { tool: string; short: string; category: string }[];
}

/**
 * How many columns a connector's acts are worth, at most.
 *
 * Width alone is the wrong input: WebEx has three acts, and three columns
 * of one item each is not a layout, it is three items flung to the far
 * corners of an empty panel. The ceiling rises with the list, so Jira's
 * thirty-nine get all three and Knowledge's three stay a list.
 *
 * Written out in full because Tailwind scans source for literal class
 * names — a template built from a number produces classes that exist in
 * this file and in no stylesheet.
 */
function columnsFor(count: number): string {
  if (count <= 3) return '';
  if (count <= 8) return '@md:columns-2';
  return '@md:columns-2 @3xl:columns-3';
}

export default function PreferencesForm({
  tenantId,
  connectors,
  initial,
}: {
  tenantId: string;
  connectors: ConnectorRow[];
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

  /** One act. An explicit choice is stored even when it matches the
   *  default: the default can change, and somebody who chose should not be
   *  quietly moved when it does. */
  function setTool(tool: string, on: boolean) {
    update({ ...prefs, tools: { ...prefs.tools, [tool]: on } });
  }

  /** The per-connector catch-all, which is the 'other' category. */
  function setCatchAll(connector: string, on: boolean) {
    const forConnector = { ...(prefs.acts[connector] ?? {}), other: on };
    update({ ...prefs, acts: { ...prefs.acts, [connector]: forConnector } });
  }

  function setWholeConnector(row: ConnectorRow, on: boolean) {
    const tools = { ...prefs.tools };
    for (const act of row.acts) tools[act.tool] = on;
    update({ ...prefs, tools });
  }

  const wanted = (connector: string, category: string, tool: string | null) =>
    wantsAct(prefs, connector, category, tool);

  /** Curated rows only — the catch-all is counted separately because it
   *  stands for a hundred tools, not one. */
  const countOn = (row: ConnectorRow) =>
    row.acts.filter((act) => wanted(row.key, act.category, act.tool)).length;

  /** Tool switches for tools this build no longer has wording for — an
   *  older page's saves, or a tool that was renamed. Shown only when there
   *  are some, so nobody's choice is stranded invisibly. */
  const known = new Set(connectors.flatMap((row) => row.acts.map((act) => act.tool)));
  const strays = Object.entries(prefs.tools).filter(([tool]) => !known.has(tool));

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

        <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          <h3 className="font-semibold">Runs</h3>
          <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
            When an agent of yours starts and stops — and when someone you shared one with changes
            it.
          </p>
          {/* Side by side once there is room, so this does not occupy a
              third of the page to say very little. */}
          <div className="@container mt-3">
            <div className="grid grid-cols-1 gap-x-6 gap-y-2 @xl:grid-cols-3">
              {(
                [
                  ['runStarted', 'A run starts', 'Frequent, and rarely the interesting part.'],
                  ['runFinished', 'A run finishes', null],
                  ['runFailed', 'A run fails', null],
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
        </section>

        <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          <h3 className="font-semibold">Things your agents do</h3>
          <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
            Only actions that change something are ever offered here — reading is never announced.
            Open a connector to choose which of its actions you hear about.
          </p>

          <div className="mt-3 space-y-1.5">
            {connectors.map((row) => {
              const on = countOn(row);
              const catchAll = wanted(row.key, 'other', null);
              return (
                <details
                  key={row.key}
                  className="rounded-lg border border-gray-200 dark:border-gray-800"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm">
                    <ConnectorIcon capabilityKey={row.key} label={row.label} size={16} />
                    <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
                    <span className="shrink-0 text-xs text-gray-500 dark:text-gray-400">
                      {on} of {row.acts.length}
                      {catchAll ? ', plus anything else' : ''}
                    </span>
                    <span aria-hidden="true" className="shrink-0 text-gray-400">
                      ▾
                    </span>
                  </summary>

                  <div className="border-t border-gray-200 p-3 dark:border-gray-800">
                    <div className="mb-2 flex items-center gap-3 text-xs">
                      <button
                        type="button"
                        onClick={() => setWholeConnector(row, true)}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        Select all
                      </button>
                      <button
                        type="button"
                        onClick={() => setWholeConnector(row, false)}
                        className="text-gray-500 hover:underline"
                      >
                        Select none
                      </button>
                    </div>

                    {/*
                      Columns from the PANEL's width, not the window's: this
                      sits inside a card inside a page whose max-width is not
                      the viewport, so a `md:` here would be measuring the
                      wrong box. `items-start` keeps the checkbox level with
                      the first line of a label that wraps.

                      `@container` must be a PARENT of the columns rather
                      than the element itself — a container-query variant
                      measures the nearest ANCESTOR container, so putting
                      both on one element leaves it at a single column for
                      ever and merely looks unstyled.

                      CSS columns rather than a grid, for the direction they
                      read in. A grid fills row-major, so a checklist laid
                      out in one is read left-to-right in threes; columns
                      fill top-to-bottom, which is how a person goes down a
                      list of things to tick. The acts are ordered by
                      category, and that ordering only survives the second
                      way. `break-inside-avoid` stops a two-line label being
                      split across a column boundary.
                    */}
                    <div className="@container">
                      <ul className={`list-none ${columnsFor(row.acts.length)}`}>
                        {row.acts.map((act) => (
                          <li key={act.tool} className="break-inside-avoid pb-1">
                            <label className="flex items-start gap-2 pr-6 text-sm">
                              <input
                                type="checkbox"
                                className="mt-0.5 shrink-0"
                                checked={wanted(row.key, act.category, act.tool)}
                                onChange={(event) => setTool(act.tool, event.target.checked)}
                              />
                              <span className="min-w-0">{act.short}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* Visually separated because it is not one more act: it
                      stands for every act in this connector that Renkei has
                      no wording for yet, which is most of them by count. */}
                    <label className="mt-2 flex items-start gap-2 border-t border-gray-100 pt-2 text-sm dark:border-gray-900">
                      <input
                        type="checkbox"
                        className="mt-0.5 shrink-0"
                        checked={catchAll}
                        onChange={(event) => setCatchAll(row.key, event.target.checked)}
                      />
                      <span>
                        Anything else in {row.label}
                        <span className="block text-xs text-gray-500 dark:text-gray-400">
                          Actions with no specific wording yet. Off to start with — it is by far the
                          largest group, and it reads as “Ran jira add attachment”.
                        </span>
                      </span>
                    </label>
                  </div>
                </details>
              );
            })}
          </div>

          {strays.length > 0 ? (
            <details className="mt-3 rounded-lg border border-dashed border-gray-300 p-3 dark:border-gray-700">
              <summary className="cursor-pointer text-sm font-medium">
                Choices for actions this version no longer lists
                <span className="ml-2 font-normal text-gray-500">{strays.length}</span>
              </summary>
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Saved against a tool that has since been renamed or removed. They still apply if it
                comes back; clearing one hands it to the settings above.
              </p>
              <ul className="mt-2 space-y-1">
                {strays.map(([tool, on]) => (
                  <li key={tool} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={tool}
                      checked={on}
                      onChange={(event) => setTool(tool, event.target.checked)}
                    />
                    <code className="min-w-0 flex-1 truncate font-mono text-xs">{tool}</code>
                    <button
                      type="button"
                      onClick={() => {
                        const tools = { ...prefs.tools };
                        delete tools[tool];
                        update({ ...prefs, tools });
                      }}
                      className="shrink-0 text-xs text-gray-500 hover:underline"
                    >
                      Clear
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
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
