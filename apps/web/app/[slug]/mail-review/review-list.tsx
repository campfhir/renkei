'use client';

import { useRef, useState, useEffect } from 'react';
import { isEmailCategory } from '@/lib/email-sanitizer-guards';
import { humanizeSystemName } from '@/lib/email-sanitizer-display';

type Category = 'human' | 'system_notification' | 'marketing';

interface ReviewItem {
  refId: string;
  provider: string;
  accountId: string | null;
  category: Category;
  senderKey: string | null;
  needsReview: boolean;
  matchScore: number | null;
  excerpt: string;
  overrideAction: string | null;
  createdAt: string;
}

type CategoryCounts = Record<Category, number>;

interface MarkedField {
  name: string;
  start: number;
  end: number;
}

// A spot check, not a browsable archive — the API caps at this too.
const PAGE_SIZE = 5;

const cardClass =
  'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950';
const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900';
const buttonClass =
  'rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-100 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-900';

const TABS: Array<{ category: Category; label: string }> = [
  { category: 'human', label: 'Human correspondence' },
  { category: 'system_notification', label: 'System notifications' },
  { category: 'marketing', label: 'Marketing' },
];

function categoryLabel(category: Category): string {
  if (category === 'system_notification') return 'System notification';
  if (category === 'marketing') return 'Marketing (excluded)';
  return 'Human correspondence';
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

async function postJson(url: string, body: unknown): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) return null;
    const data = await response.json().catch(() => null);
    if (typeof data?.error === 'string') return data.error;
    return `Request failed (${response.status})`;
  } catch {
    return 'Could not reach the server';
  }
}

/** The "teach this system's format" flow: mark spans in the excerpt, name each one, save. */
function TeachTemplate({
  tenantId,
  senderKey,
  sample,
  onSaved,
}: {
  tenantId: string;
  senderKey: string;
  sample: string;
  onSaved: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [fields, setFields] = useState<MarkedField[]>([]);
  const [fieldName, setFieldName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function markSelection() {
    const el = textareaRef.current;
    if (!el || !fieldName.trim()) return;
    const { selectionStart, selectionEnd } = el;
    if (selectionEnd <= selectionStart) {
      setError('Select some text in the sample first');
      return;
    }
    setFields((current) => [
      ...current,
      { name: fieldName.trim(), start: selectionStart, end: selectionEnd },
    ]);
    setFieldName('');
    setError(null);
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await postJson(`/api/tenant/${tenantId}/mail-review/templates`, {
      senderKey,
      sample,
      markedFields: fields,
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setNotice('Saved — every future message from this system now uses the new format.');
    setFields([]);
    onSaved();
  }

  return (
    <div className="mt-3 rounded-md border border-dashed border-gray-300 p-3 dark:border-gray-700">
      <p className="mb-2 text-xs text-gray-600 dark:text-gray-400">
        Select the parts of this message that change every time (the ticket id, the status, …), name
        each one, and save. Everything you don&apos;t mark becomes fixed text every future message
        from <strong>{humanizeSystemName(senderKey)}</strong> must match.
      </p>
      <textarea
        ref={textareaRef}
        readOnly
        value={sample}
        rows={6}
        className={`${inputClass} font-mono text-xs`}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={fieldName}
          onChange={(e) => setFieldName(e.target.value)}
          placeholder="What is this? (e.g. ticket number)"
          className={`${inputClass} max-w-[220px]`}
        />
        <button type="button" onClick={markSelection} className={buttonClass}>
          Mark selection
        </button>
      </div>
      {fields.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {fields.map((field, i) => (
            <li
              key={`${field.name}-${field.start}`}
              className="flex items-center justify-between gap-2"
            >
              <span>
                <span className="font-medium">{field.name}</span>:{' '}
                <span className="font-mono">{sample.slice(field.start, field.end)}</span>
              </span>
              <button
                type="button"
                onClick={() => setFields((current) => current.filter((_, idx) => idx !== i))}
                className="text-red-600 hover:underline dark:text-red-400"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={busy || fields.length === 0}
          onClick={() => void save()}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {notice && <span className="text-xs text-green-700 dark:text-green-300">{notice}</span>}
        {error && <span className="text-xs text-red-700 dark:text-red-300">{error}</span>}
      </div>
    </div>
  );
}

function ReviewCard({
  tenantId,
  item,
  onChanged,
}: {
  tenantId: string;
  item: ReviewItem;
  onChanged: () => void;
}) {
  const [teaching, setTeaching] = useState(false);
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassifyCategory, setReclassifyCategory] = useState<Category>('human');
  const [reclassifySystem, setReclassifySystem] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function override(
    action: 'exclude' | 'reclassify',
    category?: Category,
    senderKey?: string
  ) {
    setBusy(true);
    setNotice(null);
    setError(null);
    const failure = await postJson(`/api/tenant/${tenantId}/mail-review/override`, {
      refId: item.refId,
      action,
      category,
      senderKey: senderKey || undefined,
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setNotice('Applied — reprocessing now.');
    setReclassifying(false);
    onChanged();
  }

  return (
    <div className={cardClass}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{categoryLabel(item.category)}</span>
          {item.senderKey && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              from {humanizeSystemName(item.senderKey)}
            </span>
          )}
          {item.needsReview && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
              Needs review
            </span>
          )}
        </div>
        <span className="text-xs text-gray-400">{new Date(item.createdAt).toLocaleString()}</span>
      </div>

      <pre className="mb-3 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-gray-50 p-2 text-xs text-gray-700 dark:bg-gray-900 dark:text-gray-300">
        {item.excerpt}
      </pre>

      {item.overrideAction && (
        <p className="mb-2 text-xs text-blue-700 dark:text-blue-300">
          You applied an override: <span className="font-mono">{item.overrideAction}</span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void override('exclude')}
          className={buttonClass}
        >
          Remove entirely
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setReclassifying((v) => !v)}
          className={buttonClass}
        >
          Reclassify…
        </button>
        {item.category === 'system_notification' && item.needsReview && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setTeaching((v) => !v)}
            className={buttonClass}
          >
            Teach this system&apos;s format
          </button>
        )}
      </div>

      {reclassifying && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-200 pt-3 dark:border-gray-800">
          <select
            value={reclassifyCategory}
            onChange={(e) => {
              const { value } = e.target;
              if (isEmailCategory(value)) setReclassifyCategory(value);
            }}
            className={`${inputClass} w-auto`}
          >
            <option value="human">Human correspondence</option>
            <option value="system_notification">System notification</option>
            <option value="marketing">Marketing</option>
          </select>
          {reclassifyCategory === 'system_notification' && (
            <input
              value={reclassifySystem}
              onChange={(e) => setReclassifySystem(e.target.value)}
              placeholder="Which system? (e.g. Jira, Paycom)"
              className={`${inputClass} w-auto max-w-[200px]`}
            />
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void override('reclassify', reclassifyCategory, reclassifySystem)}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      )}

      {teaching && (
        <TeachTemplate
          tenantId={tenantId}
          senderKey={item.senderKey ?? ''}
          sample={item.excerpt}
          onSaved={() => {
            setTeaching(false);
            onChanged();
          }}
        />
      )}

      {(notice || error) && (
        <p
          className={`mt-2 text-xs ${error ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}
        >
          {error ?? notice}
        </p>
      )}
    </div>
  );
}

export default function ReviewList({ tenantId }: { tenantId: string }) {
  const [category, setCategory] = useState<Category>('human');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [counts, setCounts] = useState<CategoryCounts>({
    human: 0,
    system_notification: 0,
    marketing: 0,
  });
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const { data, error: err } = await getJson<{
      items: ReviewItem[];
      totalCount: number;
      counts: CategoryCounts;
    }>(
      `/api/tenant/${tenantId}/mail-review?category=${category}&page=${page}&pageSize=${PAGE_SIZE}`
    );
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setItems(data?.items ?? []);
    setTotalCount(data?.totalCount ?? 0);
    if (data?.counts) setCounts(data.counts);
  }

  useEffect(() => {
    void reload();
  }, [tenantId, category, page]);

  function selectCategory(next: Category) {
    if (next === category) return;
    setCategory(next);
    setPage(1);
    setItems(null);
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-800">
        {TABS.map((tab) => (
          <button
            key={tab.category}
            type="button"
            onClick={() => selectCategory(tab.category)}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${
              category === tab.category
                ? 'border-blue-600 text-blue-700 dark:text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
          >
            {tab.label} ({counts[tab.category]})
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      {!error && !items && <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>}
      {!error && items && items.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">Nothing here yet.</p>
      )}

      {!error && items && items.length > 0 && (
        <>
          <div className="space-y-4">
            {items.map((item) => (
              <ReviewCard
                key={item.refId}
                tenantId={tenantId}
                item={item}
                onChanged={() => void reload()}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-3">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className={buttonClass}
              >
                Previous
              </button>
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className={buttonClass}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
