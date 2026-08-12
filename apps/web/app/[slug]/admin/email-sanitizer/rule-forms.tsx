'use client';

import { FormEvent, useEffect, useState } from 'react';
import { isEmailCategory, isClassifierMatchType } from '@/lib/email-sanitizer-guards';
import { humanizeSystemName } from '@/lib/email-sanitizer-display';

/**
 * Content-free admin surface: a rule is a sender/domain/subject pattern
 * plus a category, never message content. Template health is read-only
 * numbers (version, status, a drift count) — templates themselves are
 * authored from a message owner's own mail-review page, not here.
 */

type Category = 'human' | 'system_notification' | 'marketing';
type MatchType =
  | 'domain'
  | 'sender_email'
  | 'subject_contains'
  | 'sender_domain'
  | 'reply_to_domain'
  | 'message_id_contains';

interface ClassifierRule {
  id: string;
  category: Category;
  matchType: MatchType;
  matchValue: string;
  senderKey: string | null;
  priority: number;
  enabled: boolean;
}

interface TemplateHealthRow {
  senderKey: string;
  version: number;
  status: string;
  matchThreshold: number;
  needsReviewCount: number;
}

interface BannerPattern {
  id: string;
  phrase: string;
  enabled: boolean;
}

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
const labelClass = 'block text-sm font-medium mb-1';
const hintClass = 'mt-1 text-xs text-gray-500 dark:text-gray-400';

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <h2 className="mb-3 font-semibold">{title}</h2>
      {children}
    </div>
  );
}

async function getJson<T>(url: string): Promise<{ data: T | null; error: string | null }> {
  try {
    const response = await fetch(url);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        typeof body?.error === 'string' ? body.error : `Request failed (${response.status})`;
      return { data: null, error: message };
    }
    return { data: body, error: null };
  } catch {
    return { data: null, error: 'Could not reach the server' };
  }
}

async function sendJson(
  url: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown
): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.ok) return null;
    const data = await response.json().catch(() => null);
    if (typeof data?.error === 'string') return data.error;
    return `Request failed (${response.status})`;
  } catch {
    return 'Could not reach the server';
  }
}

interface RuleDraft {
  category: Category;
  matchType: MatchType;
  matchValue: string;
  senderKey: string;
  priority: number;
  enabled: boolean;
}

const emptyDraft: RuleDraft = {
  category: 'system_notification',
  matchType: 'domain',
  matchValue: '',
  senderKey: '',
  priority: 100,
  enabled: true,
};

function RulesCard({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/email-sanitizer/rules`;
  const [rules, setRules] = useState<ClassifierRule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const { data, error: err } = await getJson<{ rules: ClassifierRule[] }>(url);
    if (err) {
      setLoadError(err);
      return;
    }
    setLoadError(null);
    setRules(data?.rules ?? []);
  }

  useEffect(() => {
    void reload();
  }, [slug]);

  function startEdit(rule: ClassifierRule) {
    setEditingId(rule.id);
    setDraft({
      category: rule.category,
      matchType: rule.matchType,
      matchValue: rule.matchValue,
      senderKey: rule.senderKey ?? '',
      priority: rule.priority,
      enabled: rule.enabled,
    });
    setNotice(null);
    setError(null);
  }

  function startNew() {
    setEditingId(null);
    setDraft(emptyDraft);
    setNotice(null);
    setError(null);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);

    const payload = {
      category: draft.category,
      matchType: draft.matchType,
      matchValue: draft.matchValue.trim(),
      senderKey: draft.senderKey.trim() || null,
      priority: draft.priority,
      enabled: draft.enabled,
    };
    const failure = editingId
      ? await sendJson(`${url}/${editingId}`, 'PUT', payload)
      : await sendJson(url, 'POST', payload);

    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setNotice('Saved');
    startNew();
    await reload();
  }

  async function remove(id: string) {
    setBusy(true);
    const failure = await sendJson(`${url}/${id}`, 'DELETE');
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    if (editingId === id) startNew();
    await reload();
  }

  return (
    <Card title="Classifier rules">
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Evaluated in priority order (lowest first); the first enabled match wins. Mail matching no
        rule is treated as human correspondence and cleaned generically — never dropped.
      </p>

      {loadError && <p className="mb-3 text-sm text-red-700 dark:text-red-300">{loadError}</p>}

      {rules && rules.length > 0 && (
        <div className="mb-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase text-gray-500 dark:border-gray-800">
                <th className="py-2 pr-3">Priority</th>
                <th className="py-2 pr-3">Category</th>
                <th className="py-2 pr-3">Match</th>
                <th className="py-2 pr-3">System</th>
                <th className="py-2 pr-3">Enabled</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-gray-100 dark:border-gray-900">
                  <td className="py-2 pr-3">{rule.priority}</td>
                  <td className="py-2 pr-3">{rule.category}</td>
                  <td className="py-2 pr-3 font-mono text-xs">
                    {rule.matchType}: {rule.matchValue}
                  </td>
                  <td className="py-2 pr-3">
                    {rule.senderKey ? humanizeSystemName(rule.senderKey) : '—'}
                  </td>
                  <td className="py-2 pr-3">{rule.enabled ? 'Yes' : 'No'}</td>
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      onClick={() => startEdit(rule)}
                      className="mr-3 text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(rule.id)}
                      className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form
        onSubmit={(e) => void save(e)}
        className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-800"
      >
        <p className="text-sm font-medium">{editingId ? 'Edit rule' : 'Add a rule'}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="rule-category">
              Category
            </label>
            <select
              id="rule-category"
              className={inputClass}
              value={draft.category}
              onChange={(e) => {
                const { value } = e.target;
                if (isEmailCategory(value)) setDraft((d) => ({ ...d, category: value }));
              }}
            >
              <option value="system_notification">System notification</option>
              <option value="marketing">Marketing</option>
              <option value="human">Human (explicit override)</option>
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="rule-match-type">
              Match type
            </label>
            <select
              id="rule-match-type"
              className={inputClass}
              value={draft.matchType}
              onChange={(e) => {
                const { value } = e.target;
                if (isClassifierMatchType(value)) setDraft((d) => ({ ...d, matchType: value }));
              }}
            >
              <option value="domain">From address domain</option>
              <option value="sender_email">Exact From address</option>
              <option value="subject_contains">Subject contains</option>
              <option value="sender_domain">
                Actual sender domain (catches spoofed/relayed mail)
              </option>
              <option value="reply_to_domain">Reply-To domain</option>
              <option value="message_id_contains">Message-ID contains (last resort)</option>
            </select>
          </div>
        </div>
        <div>
          <label className={labelClass} htmlFor="rule-match-value">
            Match value
          </label>
          <input
            id="rule-match-value"
            required
            value={draft.matchValue}
            onChange={(e) => setDraft((d) => ({ ...d, matchValue: e.target.value }))}
            placeholder={
              draft.matchType === 'sender_email'
                ? 'notifications@jira.example.com'
                : draft.matchType === 'subject_contains'
                  ? '[jira]'
                  : draft.matchType === 'message_id_contains'
                    ? 'odspnotify'
                    : 'sharepointonline.com'
            }
            className={`${inputClass} font-mono`}
          />
          {(draft.matchType === 'sender_domain' || draft.matchType === 'reply_to_domain') && (
            <p className={hintClass}>
              Matches the true sending system even when the visible From address is a real
              colleague&apos;s — the pattern behind SharePoint/OneDrive-style sharing notifications,
              which display as coming from whoever shared the file but are actually sent by a
              Microsoft system account.
            </p>
          )}
          {draft.matchType === 'message_id_contains' && (
            <p className={hintClass}>
              For when even Reply-To shows a real colleague (Exchange sometimes sets it back to the
              sharing user). SharePoint/OneDrive share notifications always carry{' '}
              <code className="font-mono">odspnotify</code> in their Message-ID — no human-composed
              message ever does.
            </p>
          )}
        </div>
        {draft.category === 'system_notification' && (
          <div>
            <label className={labelClass} htmlFor="rule-sender-key">
              Which system?
            </label>
            <input
              id="rule-sender-key"
              required
              value={draft.senderKey}
              onChange={(e) => setDraft((d) => ({ ...d, senderKey: e.target.value }))}
              placeholder="jira"
              className={`${inputClass} font-mono`}
            />
            <p className={hintClass}>
              A short identifier for this sender (e.g. &quot;jira&quot;) — shown to users as{' '}
              {draft.senderKey ? `"${humanizeSystemName(draft.senderKey)}"` : 'a readable name'}. A
              message owner teaches the actual format from a real message on their Mail review page.
            </p>
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="rule-priority">
              Priority
            </label>
            <input
              id="rule-priority"
              type="number"
              value={draft.priority}
              onChange={(e) => setDraft((d) => ({ ...d, priority: Number(e.target.value) || 0 }))}
              className={inputClass}
            />
            <p className={hintClass}>Lower runs first.</p>
          </div>
          <label className="flex items-center gap-2 pt-6 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
            />
            Enabled
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : editingId ? 'Save changes' : 'Add rule'}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={startNew}
              className="text-sm text-gray-600 hover:underline dark:text-gray-400"
            >
              Cancel edit
            </button>
          )}
          {notice && <span className="text-sm text-green-700 dark:text-green-300">{notice}</span>}
          {error && <span className="text-sm text-red-700 dark:text-red-300">{error}</span>}
        </div>
      </form>
    </Card>
  );
}

function BannersCard({ slug }: { slug: string }) {
  const url = `/api/admin/${slug}/email-sanitizer/banners`;
  const [banners, setBanners] = useState<BannerPattern[] | null>(null);
  const [seeds, setSeeds] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [phrase, setPhrase] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const { data, error: err } = await getJson<{ banners: BannerPattern[]; seeds: string[] }>(url);
    if (err) {
      setLoadError(err);
      return;
    }
    setLoadError(null);
    setBanners(data?.banners ?? []);
    setSeeds(data?.seeds ?? []);
  }

  useEffect(() => {
    void reload();
  }, [slug]);

  function startEdit(banner: BannerPattern) {
    setEditingId(banner.id);
    setPhrase(banner.phrase);
    setEnabled(banner.enabled);
    setNotice(null);
    setError(null);
  }

  function startNew() {
    setEditingId(null);
    setPhrase('');
    setEnabled(true);
    setNotice(null);
    setError(null);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);

    const payload = { phrase: phrase.trim(), enabled };
    const failure = editingId
      ? await sendJson(`${url}/${editingId}`, 'PUT', payload)
      : await sendJson(url, 'POST', payload);

    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setNotice('Saved');
    startNew();
    await reload();
  }

  async function remove(id: string) {
    setBusy(true);
    const failure = await sendJson(`${url}/${id}`, 'DELETE');
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    if (editingId === id) startNew();
    await reload();
  }

  return (
    <Card title="External-sender banner library">
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Literal warning banners a mail gateway prepends to outside mail (e.g. &quot;CAUTION: This
        Email is from an EXTERNAL source...&quot;) are stripped before a message is cleaned, so they
        never dilute embeddings. Add a phrase here when a gateway wording changes or a new one shows
        up — no code deploy needed.
      </p>

      {seeds.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
            Built in (always active)
          </p>
          <ul className="space-y-1">
            {seeds.map((seed) => (
              <li
                key={seed}
                className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-400"
              >
                {seed}
              </li>
            ))}
          </ul>
        </div>
      )}

      {loadError && <p className="mb-3 text-sm text-red-700 dark:text-red-300">{loadError}</p>}

      {banners && banners.length > 0 && (
        <div className="mb-4 space-y-2">
          {banners.map((banner) => (
            <div
              key={banner.id}
              className="flex items-start justify-between gap-3 rounded-md border border-gray-200 px-3 py-2 dark:border-gray-800"
            >
              <p className="text-xs text-gray-700 dark:text-gray-300">
                {!banner.enabled && <span className="mr-2 text-gray-400">(disabled)</span>}
                {banner.phrase}
              </p>
              <div className="flex shrink-0 gap-3">
                <button
                  type="button"
                  onClick={() => startEdit(banner)}
                  className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  Edit
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(banner.id)}
                  className="text-xs font-medium text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => void save(e)}
        className="space-y-3 border-t border-gray-200 pt-4 dark:border-gray-800"
      >
        <p className="text-sm font-medium">{editingId ? 'Edit phrase' : 'Add a phrase'}</p>
        <div>
          <label className={labelClass} htmlFor="banner-phrase">
            Banner text
          </label>
          <textarea
            id="banner-phrase"
            required
            rows={2}
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="[EXTERNAL EMAIL] DO NOT CLICK links or attachments unless you recognize the sender..."
            className={inputClass}
          />
          <p className={hintClass}>
            Matched word-by-word regardless of line-wrapping — paste the exact banner text as it
            appears in a real message.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : editingId ? 'Save changes' : 'Add phrase'}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={startNew}
              className="text-sm text-gray-600 hover:underline dark:text-gray-400"
            >
              Cancel edit
            </button>
          )}
          {notice && <span className="text-sm text-green-700 dark:text-green-300">{notice}</span>}
          {error && <span className="text-sm text-red-700 dark:text-red-300">{error}</span>}
        </div>
      </form>
    </Card>
  );
}

function TemplateHealthCard({ slug }: { slug: string }) {
  const [rows, setRows] = useState<TemplateHealthRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { data, error: err } = await getJson<{ templates: TemplateHealthRow[] }>(
        `/api/admin/${slug}/email-sanitizer/templates`
      );
      if (err) {
        setError(err);
        return;
      }
      setRows(data?.templates ?? []);
    })();
  }, [slug]);

  return (
    <Card title="Template health">
      <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
        Read-only. A rising drift count means a sender restyled its notification format — its mail
        still gets cleaned generically in the meantime, never garbled or dropped, but the template
        should be re-taught from a fresh sample.
      </p>
      {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      {rows && rows.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">No active templates yet.</p>
      )}
      {rows && rows.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-xs uppercase text-gray-500 dark:border-gray-800">
              <th className="py-2 pr-3">System</th>
              <th className="py-2 pr-3">Version</th>
              <th className="py-2 pr-3">Threshold</th>
              <th className="py-2 pr-3">Drift (7d)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.senderKey} className="border-b border-gray-100 dark:border-gray-900">
                <td className="py-2 pr-3">{humanizeSystemName(row.senderKey)}</td>
                <td className="py-2 pr-3">v{row.version}</td>
                <td className="py-2 pr-3">{row.matchThreshold}</td>
                <td className="py-2 pr-3">
                  {row.needsReviewCount > 0 ? (
                    <span className="font-medium text-amber-700 dark:text-amber-400">
                      {row.needsReviewCount}
                    </span>
                  ) : (
                    '0'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export default function RuleForms({ slug }: { slug: string }) {
  return (
    <div className="space-y-6">
      <RulesCard slug={slug} />
      <BannersCard slug={slug} />
      <TemplateHealthCard slug={slug} />
    </div>
  );
}
