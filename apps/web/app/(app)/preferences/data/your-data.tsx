'use client';

/**
 * The Your data page's body (page.tsx beside it): take it with you, and
 * bring it in. Two downloads — everything
 * as a zip (GET /api/account/export), and a Markdown profile another
 * assistant can learn from (…/export/profile) — and an import from
 * ChatGPT, Claude, Gemini (Google Takeout), a Renkei export, or plain
 * Markdown/text, previewed before anything is written. What the import
 * decides is your-data.model.ts.
 */

import { useReducer, useRef } from 'react';
import Link from 'next/link';
import { reportFetchFailure } from '@/lib/fetch-json';
import {
  canImport,
  canPreview,
  fileProblem,
  importLabel,
  importQuery,
  importedFromAnswer,
  initYourData,
  outcomeWords,
  previewLabel,
  previewFromAnswer,
  previewQuery,
  previewWords,
  refusalWords,
  showsPreview,
  yourDataReducer,
} from './your-data.model';

const IMPORT_URL = '/api/account/import';
const BUTTON =
  'rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';
const CARD = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950';
const LINK_BUTTON =
  'inline-flex items-center rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900';

export default function YourData() {
  const [state, dispatch] = useReducer(yourDataReducer, undefined, initYourData);
  const file = useRef<File | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  function body(): BodyInit {
    return state.input === 'file' && file.current ? file.current : state.pasted;
  }

  /** The 200 answer's body, or the words saying why there is none. */
  async function send(
    query: string
  ): Promise<{ ok: true; answer: unknown } | { ok: false; problem: string }> {
    try {
      const response = await fetch(`${IMPORT_URL}?${query}`, { method: 'POST', body: body() });
      const answer: unknown = await response.json().catch(() => null);
      if (response.ok) return { ok: true, answer };
      const problem = refusalWords(answer);
      reportFetchFailure('POST', IMPORT_URL, response.status, problem);
      return { ok: false, problem };
    } catch (error) {
      reportFetchFailure('POST', IMPORT_URL, 0, 'Could not reach the server', error);
      return { ok: false, problem: 'Could not reach the server.' };
    }
  }

  async function preview() {
    dispatch({ type: 'previewSent' });
    const sent = await send(previewQuery(state));
    const found = sent.ok ? previewFromAnswer(sent.answer) : null;
    if (found) dispatch({ type: 'previewed', preview: found });
    else dispatch({ type: 'failed', problem: sent.ok ? 'Could not import that.' : sent.problem });
  }

  async function runImport() {
    dispatch({ type: 'importSent' });
    const sent = await send(importQuery(state));
    const done = sent.ok ? importedFromAnswer(sent.answer) : null;
    if (done) dispatch({ type: 'imported', outcome: done.outcome, notes: done.notes });
    else dispatch({ type: 'failed', problem: sent.ok ? 'Could not import that.' : sent.problem });
  }

  function startOver() {
    file.current = null;
    if (fileInput.current) fileInput.current.value = '';
    dispatch({ type: 'startedOver' });
  }

  const tooBig = fileProblem(state);
  const shown = state.preview;

  return (
    <div className="space-y-6">
      <section aria-labelledby="export-heading" className={CARD}>
        <h2 id="export-heading" className="font-semibold">
          Export
        </h2>
        <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
          The zip has every chat you own, your memory, projects and preferences. The profile is a
          summary of you to paste into or upload to ChatGPT, Claude or Gemini.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href="/api/account/export" download className={LINK_BUTTON}>
            Download all my data (.zip)
          </a>
          <a href="/api/account/export/profile" download className={LINK_BUTTON}>
            Download profile for other assistants (.md)
          </a>
        </div>
      </section>

      <section aria-labelledby="import-heading" className={CARD}>
        <h2 id="import-heading" className="font-semibold">
          Import
        </h2>
        <p className="mt-0.5 text-sm text-gray-600 dark:text-gray-400">
          A ChatGPT or Claude data export (the zip, or its <code>conversations.json</code>), Gemini
          activity from Google Takeout, a Renkei export, or a list of things about you in Markdown
          or text. You will see what was found before anything is added.
        </p>

        <div role="radiogroup" aria-label="Import from" className="mt-2 flex gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="import-input"
              checked={state.input === 'file'}
              onChange={() => dispatch({ type: 'inputChosen', input: 'file' })}
            />
            Upload a file
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="import-input"
              checked={state.input === 'paste'}
              onChange={() => dispatch({ type: 'inputChosen', input: 'paste' })}
            />
            Paste text
          </label>
        </div>

        {state.input === 'file' ? (
          <div className="mt-2">
            <label htmlFor="import-file" className="sr-only">
              File to import
            </label>
            <input
              id="import-file"
              ref={fileInput}
              type="file"
              accept=".zip,.json,.md,.markdown,.txt,application/zip,application/json,text/markdown,text/plain"
              onChange={(event) => {
                const chosen = event.target.files?.[0] ?? null;
                file.current = chosen;
                dispatch(
                  chosen
                    ? { type: 'fileChosen', name: chosen.name, size: chosen.size }
                    : { type: 'fileCleared' }
                );
              }}
              className="block w-full max-w-md text-sm file:mr-3 file:rounded-md file:border-0 file:bg-gray-100 file:px-3 file:py-1.5 file:text-sm dark:file:bg-gray-800"
            />
            {tooBig ? (
              <p className="mt-1 text-sm text-red-600 dark:text-red-400">{tooBig}</p>
            ) : null}
          </div>
        ) : (
          <div className="mt-2">
            <label htmlFor="import-text" className="sr-only">
              Text to import
            </label>
            <textarea
              id="import-text"
              rows={5}
              value={state.pasted}
              placeholder={'- I live in Denver\n- I prefer short answers'}
              onChange={(event) => dispatch({ type: 'pasted', text: event.target.value })}
              className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900"
            />
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Tip: ask another assistant &ldquo;List everything you know about me as bullet
              points&rdquo; and paste its answer here.
            </p>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void preview()}
            disabled={!canPreview(state)}
            className={BUTTON}
          >
            {previewLabel(state)}
          </button>
          {state.phase === 'failed' ? (
            <span role="alert" className="text-sm text-red-600 dark:text-red-400">
              {state.problem}
            </span>
          ) : null}
        </div>

        {shown && showsPreview(state) ? (
          <div
            aria-label="What was found"
            role="region"
            className="mt-3 rounded-md border border-gray-200 p-3 text-sm dark:border-gray-800"
          >
            <p className="font-medium">{previewWords(shown)}</p>
            {shown.sampleMemories.length > 0 ? (
              <ul className="mt-2 list-disc pl-5 text-gray-700 dark:text-gray-300">
                {shown.sampleMemories.map((memory) => (
                  <li key={memory}>{memory}</li>
                ))}
                {shown.memories > shown.sampleMemories.length ? (
                  <li className="list-none text-gray-500">
                    …and {shown.memories - shown.sampleMemories.length} more
                  </li>
                ) : null}
              </ul>
            ) : null}
            {shown.sampleChats.length > 0 ? (
              <ul className="mt-2 list-disc pl-5 text-gray-700 dark:text-gray-300">
                {shown.sampleChats.map((chat, index) => (
                  <li key={`${chat.title}-${index}`}>
                    {chat.title} <span className="text-gray-500">({chat.messages} messages)</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {shown.notes.map((note) => (
              <p key={note} className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {note}
              </p>
            ))}
            <fieldset className="mt-3 space-y-1">
              <legend className="sr-only">What to import</legend>
              {shown.memories > 0 ? (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={state.memories}
                    onChange={() => dispatch({ type: 'toggled', option: 'memories' })}
                  />
                  Add memories to what your assistant remembers
                </label>
              ) : null}
              {shown.chats > 0 ? (
                <>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={state.chats}
                      onChange={() => dispatch({ type: 'toggled', option: 'chats' })}
                    />
                    Import chats
                  </label>
                  <label className="ml-6 flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={state.archiveChats}
                      disabled={!state.chats}
                      onChange={() => dispatch({ type: 'toggled', option: 'archiveChats' })}
                    />
                    Put imported chats in the archive
                  </label>
                </>
              ) : null}
            </fieldset>
            <button
              type="button"
              onClick={() => void runImport()}
              disabled={!canImport(state)}
              className={`mt-3 ${BUTTON}`}
            >
              {importLabel(state)}
            </button>
          </div>
        ) : null}

        {state.phase === 'imported' && state.outcome ? (
          <div
            role="status"
            className="mt-3 rounded-md border border-green-200 bg-green-50 p-3 text-sm dark:border-green-900 dark:bg-green-950"
          >
            {outcomeWords(state.outcome).map((line) => (
              <p key={line}>{line}</p>
            ))}
            {state.notes.map((note) => (
              <p key={note} className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                {note}
              </p>
            ))}
            <div className="mt-2 flex flex-wrap gap-3">
              {state.outcome.memoriesAdded > 0 ? (
                <Link href="/chat/memory" className="text-blue-700 underline dark:text-blue-400">
                  See your memory
                </Link>
              ) : null}
              <button
                type="button"
                onClick={startOver}
                className="text-blue-700 underline dark:text-blue-400"
              >
                Import something else
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
