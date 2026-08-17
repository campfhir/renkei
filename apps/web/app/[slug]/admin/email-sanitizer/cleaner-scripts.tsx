'use client';

import { useEffect, useState } from 'react';
import { getJson, sendJsonFull } from '@/lib/fetch-json';

interface CleanerScript {
  id: string;
  name: string;
  script: string;
  enabled: boolean;
  lastError: string | null;
}

const PLACEHOLDER = `(email) => email.text
  .split('\\n')
  .filter((line) => !line.startsWith('Follow NEMS:'))
  .join('\\n')`;

/**
 * Sandboxed cleaner scripts — for boilerplate the phrase library cannot
 * express. Each script is a function (email) => string run in a QuickJS
 * WebAssembly sandbox (no network, no files, hard time and memory limits);
 * a failing script never eats a message — the text passes through
 * unchanged and the error shows here. The test box runs the script in the
 * exact production sandbox before anything is saved or enabled.
 */
export default function CleanerScripts({
  slug,
  canSuggest,
}: {
  slug: string;
  canSuggest: boolean;
}) {
  const url = `/api/admin/${slug}/email-sanitizer/scripts`;
  const [scripts, setScripts] = useState<CleanerScript[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Editor state — one shared form for create and edit.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [saving, setSaving] = useState(false);

  // Test harness state. Header fields are settable so scripts keyed on
  // them (reply-to domains, message-id tags) can be exercised too.
  const [sample, setSample] = useState('');
  const [testSubject, setTestSubject] = useState('');
  const [testFrom, setTestFrom] = useState('');
  const [testReplyTo, setTestReplyTo] = useState('');
  const [testMessageId, setTestMessageId] = useState('');
  const [testOutput, setTestOutput] = useState<string | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // Model drafting: sample (shared with the test box) + optional intent in,
  // a pre-flown script out — landed in the editor, never auto-saved.
  const [instructions, setInstructions] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftRationale, setDraftRationale] = useState<string | null>(null);

  async function load() {
    const result = await getJson<{ scripts: CleanerScript[] }>(url);
    if (result.error || !result.data) setError(result.error ?? 'Could not load scripts');
    else setScripts(result.data.scripts);
  }
  useEffect(() => {
    void load();
  }, []);

  function startEdit(script: CleanerScript | null) {
    setEditingId(script?.id ?? null);
    setName(script?.name ?? '');
    setSource(script?.script ?? '');
    setTestOutput(null);
    setTestError(null);
    setError(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    const result = await sendJsonFull(url, 'POST', {
      ...(editingId ? { id: editingId } : {}),
      name,
      script: source,
      enabled: true,
    });
    setSaving(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    startEdit(null);
    await load();
  }

  async function toggle(script: CleanerScript) {
    const result = await sendJsonFull(url, 'POST', {
      id: script.id,
      name: script.name,
      script: script.script,
      enabled: !script.enabled,
    });
    if (result.error) setError(result.error);
    await load();
  }

  async function remove(script: CleanerScript) {
    if (!window.confirm(`Delete script “${script.name}”?`)) return;
    const result = await sendJsonFull(`${url}/${script.id}`, 'DELETE');
    if (result.error) setError(result.error);
    await load();
  }

  async function draft() {
    setDrafting(true);
    setError(null);
    setDraftRationale(null);
    setTestOutput(null);
    setTestError(null);
    const result = await sendJsonFull<{
      name: string;
      script: string;
      rationale: string;
      sampleOutput: string;
    }>(`${url}/suggest`, 'POST', {
      text: sample,
      ...(instructions.trim() ? { instructions } : {}),
    });
    setDrafting(false);
    if (result.error || !result.data) {
      setError(result.error ?? 'Drafting failed');
      return;
    }
    if (!name.trim()) setName(result.data.name);
    setSource(result.data.script);
    setDraftRationale(result.data.rationale);
    // The server already ran it on the sample — show the before/after now.
    setTestOutput(result.data.sampleOutput);
  }

  async function test() {
    setTesting(true);
    setTestOutput(null);
    setTestError(null);
    const result = await sendJsonFull<{ output: string }>(`${url}/test`, 'POST', {
      script: source,
      text: sample,
      ...(testSubject.trim() ? { subject: testSubject } : {}),
      ...(testFrom.trim() ? { fromAddress: testFrom } : {}),
      ...(testReplyTo.trim() ? { replyToAddress: testReplyTo } : {}),
      ...(testMessageId.trim() ? { messageId: testMessageId } : {}),
    });
    setTesting(false);
    if (result.error || !result.data) setTestError(result.error ?? 'Test failed');
    else setTestOutput(result.data.output);
  }

  return (
    <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
      <h2 className="text-sm font-semibold">Cleaner scripts</h2>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        For boilerplate a phrase can&apos;t express: a function <code>(email) =&gt; string</code>{' '}
        that transforms the cleaned message body. Scripts run in a sealed sandbox — no network, no
        files, a hard time limit — and a failing script never loses a message: the text passes
        through unchanged and the error shows here.
      </p>

      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {scripts && scripts.length > 0 && (
        <ul className="mt-3 divide-y divide-gray-100 dark:divide-gray-900">
          {scripts.map((script) => (
            <li key={script.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <span className={script.enabled ? 'font-medium' : 'font-medium text-gray-400'}>
                  {script.name}
                </span>
                {script.lastError && (
                  <p className="text-xs text-red-600 dark:text-red-400">
                    Last run failed: {script.lastError}
                  </p>
                )}
              </div>
              <span className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => void toggle(script)}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  {script.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  type="button"
                  onClick={() => startEdit(script)}
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void remove(script)}
                  className="text-red-600 hover:underline dark:text-red-400"
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 space-y-2 border-t border-gray-100 pt-3 dark:border-gray-900">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {editingId ? 'Edit script' : 'New script'}
        </p>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Script name (e.g. Strip signature blocks)"
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900"
        />
        <textarea
          value={source}
          onChange={(event) => setSource(event.target.value)}
          rows={7}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-900"
        />
        <p className="text-xs text-gray-500 dark:text-gray-400">
          <code>email</code> carries <code>text</code>, <code>subject</code>,{' '}
          <code>fromAddress</code>, <code>fromName</code> — and the header fields{' '}
          <code>senderAddress</code>, <code>replyToAddress</code>, <code>messageId</code>,{' '}
          <code>receivedAt</code> (null when the connector reported none). Return the new text.
        </p>

        <textarea
          value={sample}
          onChange={(event) => setSample(event.target.value)}
          rows={4}
          placeholder="Paste a sample body to test against…"
          className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 font-mono text-xs dark:border-gray-700 dark:bg-gray-900"
        />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(
            [
              ['Subject', testSubject, setTestSubject],
              ['From address', testFrom, setTestFrom],
              ['Reply-To', testReplyTo, setTestReplyTo],
              ['Message-ID', testMessageId, setTestMessageId],
            ] as const
          ).map(([label, value, set]) => (
            <input
              key={label}
              value={value}
              onChange={(event) => set(event.target.value)}
              placeholder={label}
              aria-label={`Test ${label}`}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
            />
          ))}
        </div>
        {canSuggest && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Optional: what should the script do? (e.g. drop the signature block)"
              className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-900"
            />
            <button
              type="button"
              disabled={drafting || sample.trim().length < 40}
              onClick={() => void draft()}
              title="Uses the pasted sample above; the draft lands in the editor for review"
              className="rounded-md border border-blue-600 px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:hover:bg-blue-900/20"
            >
              {drafting ? 'Drafting…' : '✨ Draft with your org model'}
            </button>
          </div>
        )}
        {draftRationale && (
          <p className="text-xs text-gray-600 dark:text-gray-400">
            <span className="font-semibold">Draft:</span> {draftRationale} — already run on your
            sample (output below). Review the code, then save to enable.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={testing || !source.trim() || !sample.trim()}
            onClick={() => void test()}
            className="rounded-md border border-blue-600 px-3 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:hover:bg-blue-900/20"
          >
            {testing ? 'Running…' : 'Test on sample'}
          </button>
          <button
            type="button"
            disabled={saving || !name.trim() || !source.trim()}
            onClick={() => void save()}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add script'}
          </button>
          {editingId && (
            <button
              type="button"
              onClick={() => startEdit(null)}
              className="text-sm text-gray-500 hover:underline"
            >
              Cancel
            </button>
          )}
        </div>

        {testError && <p className="text-sm text-red-600 dark:text-red-400">{testError}</p>}
        {testOutput !== null && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Output on the sample
            </p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-gray-200 bg-gray-50 p-2 font-mono text-xs dark:border-gray-800 dark:bg-gray-900">
              {testOutput || '(empty — the script removed everything)'}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
