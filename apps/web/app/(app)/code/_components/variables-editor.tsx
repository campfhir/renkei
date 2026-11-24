'use client';

/**
 * The Variables tab of a code project's Environments page: the variables
 * its pipelines run with, on its host — Bitbucket Pipelines or GitHub
 * Actions. Two sets, each a card of rows: the repository's own, which
 * every branch's runs get, and the deployment environment's (the host's
 * environment of the same name as the one picked), which only the jobs
 * deploying it get.
 *
 * A row is a name, a value and a lock; locked, it is saved as a secret,
 * and its value is never shown again. Rows are typed in, or read from a
 * `.env` file the person picks (or pastes): the file is read and parsed
 * here in the browser, its rows land in the table to be looked over and
 * locked, and nothing is sent until Save — which goes to the project's
 * variables route and from there to the host. No model takes part.
 *
 * What the editor decides — what a file adds, what Save sends, when it
 * can be pressed — is variables-editor.model.ts.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Icon, ICONS } from '@/components/icons';
import { LoadingLine } from '@/components/skeleton';
import { getJson, sendJsonFull } from '@/lib/fetch-json';
import { scrollMotion } from '@/lib/hash-scroll';
import Pill from './pill';
import {
  cardClass,
  inputClass,
  linkButtonClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './pipeline-parts';
import {
  canSave,
  changeSummary,
  editorReducer,
  fileProblem,
  importedLine,
  initialEditor,
  isDirty,
  outcomeLines,
  removalQuestion,
  rowProblem,
  rowState,
  saveRequest,
  valuePlaceholder,
  type Applied,
  type ListedVariable,
  type Row,
} from './variables-editor.model';

interface VariableSet {
  variables: ListedVariable[];
  error: string | null;
}

/** What GET /api/code/projects/[id]/variables answers. */
interface VariablesData {
  host: 'bitbucket' | 'github';
  repository: VariableSet;
  environment: (VariableSet & { name: string; exists: boolean }) | null;
  needs: string | null;
}

/** A variable the page was sent to set: which, in which set, and whether it is a secret. */
export interface VariableAsk {
  name: string;
  scope: 'repository' | 'environment';
  secured: boolean;
}

const HOST = { bitbucket: 'Bitbucket', github: 'GitHub' } as const;
const STATE_PILL = {
  new: { tone: 'green', label: 'New' },
  changed: { tone: 'blue', label: 'Changed' },
  removed: { tone: 'red', label: 'Will be removed' },
} as const;

export default function VariablesEditor({
  projectId,
  environment,
  ask = null,
}: {
  projectId: string;
  /** The project's environment picked on the page. */
  environment: string;
  ask?: VariableAsk | null;
}) {
  const url = `/api/code/projects/${projectId}/variables`;
  const [data, setData] = useState<VariablesData | { error: string } | null>(null);

  const load = useCallback(async (): Promise<VariablesData | null> => {
    const result = await getJson<VariablesData>(
      `${url}?environment=${encodeURIComponent(environment)}`
    );
    setData(result.data ?? { error: result.error ?? 'The variables could not be read.' });
    return result.data;
  }, [url, environment]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <LoadingLine label="Reading the variables…" />;
  if ('error' in data) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {data.error}
      </p>
    );
  }
  const host = HOST[data.host];
  const secretWord = data.host === 'github' ? 'a secret' : 'a secured variable';
  return (
    <div className="space-y-4" data-testid="variables-editor">
      <p className="text-xs text-gray-500">
        These live on {host}, not in Renkei. Type them in or read them from a{' '}
        <span className="font-mono">.env</span> file: the file is read in your browser, and what you
        save goes straight to {host}. Lock a row to save it as {secretWord}; its value is never
        shown again.
      </p>
      {data.needs ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">{data.needs}</p>
      ) : null}
      {data.environment ? (
        <VariableSetCard
          key={`environment-${data.environment.name}`}
          url={url}
          title={`${data.environment.name} variables`}
          hint={
            data.environment.exists
              ? `Only the jobs that deploy ${data.environment.name} get these; they win over the repository’s where both name one.`
              : `${host} has no deployment environment named ${data.environment.name} yet. Saving a variable here makes it, and the jobs that deploy ${data.environment.name} get these.`
          }
          set={data.environment}
          missingOn={data.environment.exists ? null : host}
          environment={data.environment.name}
          canEdit={data.needs === null}
          ask={ask?.scope === 'environment' ? ask : null}
          reload={load}
        />
      ) : null}
      <VariableSetCard
        key="repository"
        url={url}
        title="Repository variables"
        hint="Every run gets these, on every branch and for every environment."
        set={data.repository}
        environment={null}
        canEdit={data.needs === null}
        ask={ask?.scope === 'repository' ? ask : null}
        reload={load}
      />
    </div>
  );
}

function VariableSetCard({
  url,
  title,
  hint,
  set,
  missingOn = null,
  environment,
  canEdit,
  ask,
  reload,
}: {
  url: string;
  title: string;
  hint: string;
  set: VariableSet;
  /** The host's name, when it has no deployment environment of this name yet. */
  missingOn?: string | null;
  /** The project's environment whose set this is; null for the repository's. */
  environment: string | null;
  canEdit: boolean;
  ask: VariableAsk | null;
  reload: () => Promise<VariablesData | null>;
}) {
  const [state, dispatch] = useReducer(editorReducer, set.variables, (variables) =>
    editorReducer(initialEditor, { type: 'loaded', variables })
  );
  const picker = useRef<HTMLInputElement>(null);
  const focused = useRef<HTMLInputElement>(null);
  const scopeId = environment ? `environment-${environment}` : 'repository';
  const headingId = `variables-${scopeId}`;

  const asked = ask?.name ?? null;
  const askedSecured = ask?.secured ?? false;
  useEffect(() => {
    if (asked && canEdit) dispatch({ type: 'asked', name: asked, secured: askedSecured });
  }, [asked, askedSecured, canEdit]);
  // Sent here to set one variable: its row's value takes the cursor.
  useEffect(() => {
    const input = focused.current;
    if (state.focus === null || !input) return;
    input.scrollIntoView({ block: 'center', behavior: scrollMotion() });
    input.focus({ preventScroll: true });
  }, [state.focus]);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    const problem = fileProblem(file);
    if (problem) {
      dispatch({ type: 'failed', error: problem });
      return;
    }
    // Read here, in the browser; nothing is sent until Save.
    dispatch({ type: 'fileRead', name: file.name, text: await file.text() });
  };

  const save = async () => {
    const question = removalQuestion(state);
    if (question && !window.confirm(question)) return;
    dispatch({ type: 'sent' });
    const result = await sendJsonFull<Applied>(url, 'PUT', saveRequest(state, environment));
    if (result.error || !result.data) {
      dispatch({ type: 'failed', error: result.error ?? 'The variables could not be saved.' });
      return;
    }
    const fresh = await reload();
    const now = environment ? fresh?.environment : fresh?.repository;
    dispatch({ type: 'saved', outcome: result.data, variables: now?.variables ?? [] });
  };

  /** Make the host's deployment environment, with no variable in it yet. */
  const make = async () => {
    dispatch({ type: 'sent' });
    const result = await sendJsonFull<Applied>(url, 'PUT', {
      scope: 'environment',
      environment,
      create: true,
      set: [],
      remove: [],
    });
    if (result.error || !result.data) {
      dispatch({ type: 'failed', error: result.error ?? 'The environment could not be made.' });
      return;
    }
    const fresh = await reload();
    dispatch({
      type: 'saved',
      outcome: result.data,
      variables: fresh?.environment?.variables ?? [],
    });
  };

  const summary = changeSummary(state);
  const read = importedLine(state);
  const lines = state.outcome ? outcomeLines(state.outcome) : null;
  return (
    <section className={cardClass} aria-labelledby={headingId} data-testid={headingId}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 id={headingId} className="text-sm font-semibold">
          {title}
        </h3>
        {canEdit ? (
          <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
            <input
              ref={picker}
              type="file"
              // An environment file has no one extension: .env, .env.production, prod.env, a .txt.
              accept=".env,.txt,text/plain,*/*"
              className="sr-only"
              aria-label={`An environment file for ${title}`}
              onChange={(event) => {
                void readFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={state.busy}
              onClick={() => picker.current?.click()}
              className={`inline-flex items-center gap-1 ${linkButtonClass}`}
            >
              <Icon path={ICONS.upload} className="h-3.5 w-3.5" />
              Upload .env file
            </button>
            <button
              type="button"
              disabled={state.busy}
              onClick={() => dispatch({ type: 'pasteOpened' })}
              className={linkButtonClass}
            >
              Paste .env
            </button>
          </span>
        ) : null}
      </div>
      <p className="text-xs text-gray-500">{hint}</p>
      {set.error ? (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{set.error}</p>
      ) : null}

      {state.paste !== null ? (
        <div className="mt-3 space-y-2">
          <textarea
            value={state.paste}
            onChange={(event) => dispatch({ type: 'pasteChanged', text: event.target.value })}
            rows={5}
            spellCheck={false}
            autoFocus
            aria-label={`.env contents for ${title}`}
            placeholder={'API_BASE_URL=https://api.example.test\nDEPLOY_TOKEN=…'}
            className={`font-mono ${inputClass}`}
          />
          <div className="flex items-center justify-end gap-2">
            <p className="mr-auto text-xs text-gray-500">
              One <span className="font-mono">NAME=value</span> a line. Reading it fills the rows
              below; nothing is saved yet.
            </p>
            <button
              type="button"
              onClick={() => dispatch({ type: 'pasteCancelled' })}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!state.paste.trim()}
              onClick={() => dispatch({ type: 'pasteApplied' })}
              className={primaryButtonClass}
            >
              Read into rows
            </button>
          </div>
        </div>
      ) : null}

      {read ? (
        <p role="status" className="mt-2 text-xs text-blue-700 dark:text-blue-400">
          {read}
        </p>
      ) : null}
      {state.problems.length > 0 ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          Not read as variables: {state.problems.join('; ')}.
        </p>
      ) : null}

      {state.rows.length === 0 ? (
        <p className="mt-2 text-sm text-gray-500">No variables.</p>
      ) : (
        <ul className="mt-2 divide-y divide-gray-200 dark:divide-gray-800">
          {state.rows.map((row) => (
            <VariableRow
              key={row.id}
              row={row}
              rows={state.rows}
              canEdit={canEdit}
              busy={state.busy}
              valueRef={state.focus === row.id ? focused : undefined}
              onKey={(value) => dispatch({ type: 'rowChanged', id: row.id, field: 'key', value })}
              onValue={(value) =>
                dispatch({ type: 'rowChanged', id: row.id, field: 'value', value })
              }
              onLock={() => dispatch({ type: 'lockToggled', id: row.id })}
              onRemove={() => dispatch({ type: 'removeToggled', id: row.id })}
            />
          ))}
        </ul>
      )}

      {canEdit ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={state.busy}
            onClick={() => dispatch({ type: 'rowAdded' })}
            className={`inline-flex items-center gap-1 ${linkButtonClass}`}
          >
            <Icon path={ICONS.plus} className="h-3.5 w-3.5" />
            Add a variable
          </button>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {summary ? <span className="text-xs text-gray-500">{summary}</span> : null}
            {missingOn && environment && !isDirty(state) ? (
              <button
                type="button"
                disabled={state.busy}
                onClick={() => void make()}
                className={secondaryButtonClass}
              >
                Make {environment} on {missingOn}
              </button>
            ) : null}
            {isDirty(state) ? (
              <button
                type="button"
                disabled={state.busy}
                onClick={() => dispatch({ type: 'discarded' })}
                className={secondaryButtonClass}
              >
                Discard
              </button>
            ) : null}
            <button
              type="button"
              disabled={!canSave(state)}
              onClick={() => void save()}
              className={primaryButtonClass}
            >
              {state.busy ? 'Saving…' : 'Save'}
            </button>
          </span>
        </div>
      ) : null}

      {state.error ? (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      {lines ? (
        <div className="mt-2 space-y-1 text-xs">
          {lines.status ? (
            <p
              role="status"
              className={
                lines.status === 'Nothing changed.' && !state.outcome?.environmentCreated
                  ? 'text-gray-500'
                  : 'text-green-700 dark:text-green-400'
              }
            >
              {state.outcome?.environmentCreated && lines.status === 'Nothing changed.'
                ? ''
                : `${lines.status} `}
              {state.outcome?.environmentCreated && environment
                ? `The deployment environment ${environment} was made on the host.`
                : ''}
            </p>
          ) : null}
          {lines.refused ? (
            <p role="alert" className="text-red-600 dark:text-red-400">
              {lines.refused}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function VariableRow({
  row,
  rows,
  canEdit,
  busy,
  valueRef,
  onKey,
  onValue,
  onLock,
  onRemove,
}: {
  row: Row;
  rows: Row[];
  canEdit: boolean;
  busy: boolean;
  valueRef: React.RefObject<HTMLInputElement | null> | undefined;
  onKey: (value: string) => void;
  onValue: (value: string) => void;
  onLock: () => void;
  onRemove: () => void;
}) {
  const kind = rowState(row);
  const problem = rowProblem(row, rows);
  const name = row.key.trim() || 'the new variable';
  const pill = kind === 'same' ? null : STATE_PILL[kind];
  return (
    <li className="py-2" data-testid={`variable-${row.key || 'new'}`}>
      <div
        className={`grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto_auto] ${
          row.removed ? 'opacity-60' : ''
        }`}
      >
        {row.original ? (
          <span
            className={`col-span-3 min-w-0 truncate font-mono text-sm sm:col-span-1 ${
              row.removed ? 'line-through' : ''
            }`}
          >
            {row.key}
          </span>
        ) : (
          <input
            value={row.key}
            onChange={(event) => onKey(event.target.value)}
            disabled={busy || !canEdit}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            aria-label="Variable name"
            placeholder="NAME"
            className={`col-span-3 font-mono sm:col-span-1 ${inputClass}`}
          />
        )}
        <input
          ref={valueRef}
          value={row.value}
          onChange={(event) => onValue(event.target.value)}
          disabled={busy || !canEdit || row.removed}
          // A locked value is masked as it is typed, like a password.
          type={row.secured ? 'password' : 'text'}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-label={`Value of ${name}`}
          placeholder={valuePlaceholder(row)}
          className={`font-mono ${inputClass}`}
        />
        <button
          type="button"
          disabled={busy || !canEdit || row.removed}
          onClick={onLock}
          aria-pressed={row.secured}
          aria-label={`${name} is a secret`}
          title={row.secured ? 'A secret: saved locked, never shown again' : 'Lock it as a secret'}
          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs font-medium disabled:opacity-50 ${
            row.secured
              ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300'
              : 'border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-900'
          }`}
        >
          <Icon path={row.secured ? ICONS.lock : UNLOCKED} className="h-3.5 w-3.5" />
          {row.secured ? 'Secret' : 'Plain'}
        </button>
        {canEdit ? (
          <button
            type="button"
            disabled={busy}
            onClick={onRemove}
            aria-label={row.removed ? `Keep ${name}` : `Remove ${name}`}
            title={row.removed ? 'Keep it' : 'Remove it'}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-600 disabled:opacity-50 dark:hover:bg-gray-800"
          >
            <Icon path={row.removed ? ICONS.history : ICONS.trash} />
          </button>
        ) : (
          <span />
        )}
      </div>
      {pill || problem ? (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
          {pill ? <Pill tone={pill.tone}>{pill.label}</Pill> : null}
          {problem ? <span className="text-red-600 dark:text-red-400">{problem}</span> : null}
        </div>
      ) : null}
    </li>
  );
}

/** A padlock with its shackle swung open: a plain value. */
const UNLOCKED = 'M6 11h12v10H6zM9 11V7a3 3 0 0 1 5.6-1.5';
