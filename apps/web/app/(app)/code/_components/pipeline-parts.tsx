'use client';

/**
 * The pieces the Bitbucket Pipelines panel (pipelines-page.tsx) and the
 * GitHub Actions panel (actions-page.tsx) draw alike, so a person who
 * learned one has learned the other and a change to a card lands in both:
 * the card, input and link-button looks, the run-state and on/off pills,
 * and a variable set — its list, its one-text-box editor and the words
 * under a save. What differs per host is passed in: the words about
 * secured values, and a read-only list of secrets (GitHub's, which are
 * set on github.com). The group holds no state; its caller's reducer
 * does (pipelines-page.model.ts, actions-page.model.ts).
 */

import type { ReactNode } from 'react';
import ExternalLink from '@/components/external-link';
import type { PipelineVariable } from '@/lib/code/bitbucket-pipelines';
import Pill from './pill';
import {
  outcomeLines,
  runStatePill,
  textRows,
  variableShown,
  variablesButtonLabel,
  type Draft,
  type Outcome,
} from './pipelines-page.model';

export const cardClass = 'rounded-lg border border-gray-200 p-4 dark:border-gray-800';
export const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-900';
export const linkButtonClass =
  'text-xs font-medium whitespace-nowrap text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400';
export const secondaryButtonClass =
  'rounded-md border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900';
export const primaryButtonClass =
  'rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50';

/** A run's state as a pill: green when it passed, red when it failed, blue while it runs. */
export function RunStatePill({ state }: { state: string }) {
  const { tone, label } = runStatePill(state);
  return <Pill tone={tone}>{label}</Pill>;
}

/** On, Off, or nothing when the switch could not be read. */
export function StatusPill({ enabled }: { enabled: boolean | null }) {
  if (enabled === null) return null;
  return enabled ? <Pill tone="green">On</Pill> : <Pill tone="gray">Off</Pill>;
}

/** What differs between hosts in a variable set's words. */
export interface VariableWords {
  /** The box's example lines. */
  placeholder: string;
  /** The line under the box. */
  help: ReactNode;
}

export default function VariableGroup({
  title,
  hint,
  variables,
  secrets,
  secretsNote,
  error,
  scopeId,
  canEdit,
  needs,
  busy,
  open,
  last,
  words,
  onOpen,
  onChange,
  onCancel,
  onSave,
}: {
  title: string;
  hint: string;
  variables: PipelineVariable[];
  /** Secrets listed by name beside the variables, read-only (GitHub's). */
  secrets?: PipelineVariable[];
  /** Under the secrets: where a person sets one. */
  secretsNote?: ReactNode;
  error: string | null;
  /** The set's id for labels: 'repository', or the environment's. */
  scopeId: string;
  canEdit: boolean;
  /** Why an editor still cannot set variables, shown once on the first group. */
  needs: string | null;
  busy: boolean;
  /** The open box, when it is this set's. */
  open: Draft | null;
  /** The last save's outcome, when it was this set's. */
  last: Outcome | null;
  words: VariableWords;
  onOpen: () => void;
  onChange: (text: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const groupId = `pipeline-variables-${scopeId}`;
  const lines = last ? outcomeLines(last) : null;
  const listed = [...variables, ...(secrets ?? [])];
  return (
    <section className={cardClass} aria-labelledby={groupId}>
      <div className="flex items-center gap-2">
        <h2 id={groupId} className="text-sm font-semibold">
          {title}
        </h2>
        {canEdit && !open ? (
          <button
            type="button"
            disabled={busy}
            onClick={onOpen}
            className={`ml-auto ${linkButtonClass}`}
          >
            {variablesButtonLabel(variables)}
          </button>
        ) : null}
      </div>
      <p className="text-xs text-gray-500">{hint}</p>
      {error ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{error}</p>
      ) : open ? null : listed.length === 0 ? (
        <p className="mt-1 text-sm text-gray-500">No variables.</p>
      ) : (
        <ul className="mt-1 divide-y divide-gray-200 text-sm dark:divide-gray-800">
          {listed.map((variable) => {
            const shown = variableShown(variable);
            return (
              <li
                key={`${variable.secured ? 'secret' : 'plain'}-${variable.uuid}`}
                className="flex items-center gap-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-mono">{variable.key}</span>
                  {'secured' in shown ? (
                    <span className="ml-2">
                      <Pill tone="gray">Secured</Pill>
                    </span>
                  ) : (
                    <span className="ml-2 font-mono text-xs text-gray-500">{shown.value}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {secretsNote && !open ? <p className="mt-1 text-xs text-gray-500">{secretsNote}</p> : null}
      {needs ? <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{needs}</p> : null}
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
          aria-label={`Edit ${title}`}
          className="mt-2 space-y-2"
        >
          <textarea
            value={open.text}
            onChange={(event) => onChange(event.target.value)}
            rows={textRows(open.text, 4, 16)}
            spellCheck={false}
            aria-label={`${title} as text`}
            placeholder={words.placeholder}
            className={`font-mono ${inputClass}`}
          />
          <p className="text-xs text-gray-500">{words.help}</p>
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onCancel} className={secondaryButtonClass}>
              Cancel
            </button>
            <button type="submit" disabled={busy} className={primaryButtonClass}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      ) : null}
      {lines ? (
        <div className="mt-2 space-y-1 text-xs">
          {lines.status ? (
            <p
              role="status"
              className={
                lines.status === 'Nothing changed.'
                  ? 'text-gray-500'
                  : 'text-green-700 dark:text-green-400'
              }
            >
              {lines.status}
            </p>
          ) : null}
          {lines.notApplied ? (
            <p role="alert" className="text-red-600 dark:text-red-400">
              {lines.notApplied}
            </p>
          ) : null}
          {lines.notRead ? (
            <p className="text-amber-700 dark:text-amber-400">{lines.notRead}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** A link to the host, for a note under a card. */
export function HostLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (!href) return null;
  return (
    <ExternalLink href={href} className="underline">
      {children}
    </ExternalLink>
  );
}
