/**
 * The console's playbook CRUD pages.
 *
 * Same convention as sitesPage/peoplePage/settingsPage: plain rows in, no
 * store, JSX for escaping. A textarea rather than a rich editor, because
 * nothing in this console ships a client bundle — see ../layout.tsx.
 */

import type { ReactNode } from 'react';
import { Csrf, Section } from '../layout.js';
import { ConsolePage, type ConsoleContext } from './pages.js';
import type { AdminPlaybookSummary } from '../../gateway/admin-store.js';
import { TOOL_CATALOG } from '../../tools/catalog.js';

function base(context: ConsoleContext): string {
  return `/admin/${context.tenant.slug}`;
}

export interface PlaybooksView {
  context: ConsoleContext;
  playbooks: AdminPlaybookSummary[];
}

export function playbooksPage(view: PlaybooksView): ReactNode {
  const { context } = view;

  return (
    <ConsolePage context={context} heading="Playbooks">
      <Section title="Agile-ceremony playbooks">
        <p>
          Markdown instructions an MCP client can read with <code>list_playbooks</code> and{' '}
          <code>get_playbook</code> — how this team runs sprint planning, standup, retro, or
          anything else worth writing down once. Delete the ones you don’t use.
        </p>
        {view.playbooks.length === 0 ? (
          <p>No playbooks yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Slug</th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {view.playbooks.map((playbook) => (
                <tr key={playbook.id} className={playbook.enabled ? undefined : 'spent'}>
                  <td>
                    <a href={`${base(context)}/playbooks/${playbook.slug}/edit`}>
                      {playbook.title}
                    </a>
                    {playbook.enabled ? null : ' · disabled'}
                  </td>
                  <td>
                    <span className="mono">{playbook.slug}</span>
                  </td>
                  <td>
                    <form
                      method="post"
                      action={`${base(context)}/playbooks/${playbook.slug}/enabled`}
                    >
                      <Csrf token={context.csrfToken} />
                      <input
                        type="hidden"
                        name="enabled"
                        value={playbook.enabled ? 'false' : 'true'}
                      />
                      <button type="submit">{playbook.enabled ? 'Disable' : 'Enable'}</button>
                    </form>
                  </td>
                  <td>
                    <form
                      method="post"
                      action={`${base(context)}/playbooks/${playbook.slug}/delete`}
                    >
                      <Csrf token={context.csrfToken} />
                      <button type="submit" className="danger">
                        Delete
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p>
          <a className="btn primary" href={`${base(context)}/playbooks/new`}>
            New playbook
          </a>
        </p>
      </Section>
    </ConsolePage>
  );
}

export interface PlaybookFormView {
  context: ConsoleContext;
  /** Absent for a new playbook. */
  playbook?: { slug: string; title: string; bodyMarkdown: string };
  error?: string | null;
}

/** The tools an author can tell the model to call, for the reference panel. */
function ToolReference(): ReactNode {
  const entries = Object.entries(TOOL_CATALOG);

  return (
    <details>
      <summary>Available tools</summary>
      <table>
        <tbody>
          {entries.map(([name, description]) => (
            <tr key={name}>
              <td>
                <code>{name}</code>
              </td>
              <td className="muted">{description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export function playbookFormPage(view: PlaybookFormView): ReactNode {
  const { context, playbook } = view;
  const isNew = playbook === undefined;
  const action = isNew
    ? `${base(context)}/playbooks/new`
    : `${base(context)}/playbooks/${playbook.slug}/edit`;

  return (
    <ConsolePage context={context} heading={isNew ? 'New playbook' : `Edit ${playbook.title}`}>
      <Section title={isNew ? 'New playbook' : 'Edit playbook'}>
        {view.error ? <p className="warn">{view.error}</p> : null}
        <form method="post" action={action}>
          <Csrf token={context.csrfToken} />
          <p>
            <label htmlFor="title">Title</label>
            <br />
            <input
              id="title"
              name="title"
              required
              maxLength={200}
              defaultValue={playbook?.title ?? ''}
              style={{ width: '100%' }}
            />
          </p>
          {isNew ? (
            <p>
              <label htmlFor="slug">Slug</label>
              <br />
              <input
                id="slug"
                name="slug"
                required
                pattern="[a-z0-9][a-z0-9-]{0,62}"
                placeholder="sprint-planning"
                style={{ width: '100%' }}
              />
              <br />
              <span className="muted">
                Lowercase letters, numbers, and hyphens. This is the identifier{' '}
                <code>get_playbook</code> takes — it can’t be changed later.
              </span>
            </p>
          ) : null}
          <p>
            <label htmlFor="bodyMarkdown">Markdown</label>
            <br />
            <textarea
              id="bodyMarkdown"
              name="bodyMarkdown"
              required
              rows={16}
              defaultValue={playbook?.bodyMarkdown ?? ''}
              style={{ width: '100%', font: 'inherit' }}
            />
          </p>
          <button type="submit" className="primary">
            Save
          </button>{' '}
          <a href={`${base(context)}/playbooks`}>Cancel</a>
        </form>
        <ToolReference />
      </Section>
    </ConsolePage>
  );
}
