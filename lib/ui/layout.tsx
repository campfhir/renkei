/**
 * The chrome every Renkei page shares.
 *
 * Server-rendered React: JSX for composition and escaping by default,
 * `renderToStaticMarkup` for output, and **no client bundle** — nothing is
 * hydrated and nothing is fetched. A page rendered during a failed sign-in
 * should not itself depend on anything, which was true of the string templates
 * this replaces and stays true here.
 *
 * Escaping by default is the reason this is worth a dependency rather than more
 * template strings. These pages render an OAuth client's own `client_name`, a
 * tenant's display name, a user's Atlassian display name, and audit rows — all
 * of it text somebody else chose, some of it text an anonymous registrant chose.
 * With JSX, interpolating it safely is what happens when you do nothing special;
 * with template strings it is what happens when you remember.
 *
 * Styles are one inline `<style>` block with a small class vocabulary rather
 * than style objects on every element. A stylesheet file would be an asset to
 * serve and a request to make, and the console has enough tables that repeating
 * their styling inline stopped being readable.
 */

import type { ReactNode } from 'react';

export const ACCENT = '#4a6da7';
export const DANGER = '#b3261e';

const STYLES = `
  :root { color-scheme: light }
  body {
    font: 16px/1.55 system-ui, sans-serif;
    margin: 0; padding: 3rem 1.5rem;
    color: #1a1a1a; background: #fafafa;
  }
  main { margin: 0 auto }
  h1 {
    font-size: 1.35rem; margin: 0 0 .75rem;
    border-left: 3px solid ${ACCENT}; padding-left: .75rem;
  }
  h1.problem { border-left-color: ${DANGER} }
  h2 { font-size: 1rem; margin: 0 0 .5rem; color: #333 }
  p { margin: 0 0 1rem; color: #444 }
  p.muted, .muted { color: #666; font-size: .85rem }
  section { margin: 2rem 0 0 }
  a { color: ${ACCENT} }
  code, .mono { font-family: ui-monospace, monospace; font-size: .9rem }

  .sub { margin: 0 0 1.5rem; color: #555; font-size: .9rem }
  .footer { font-size: .85rem; color: #777; margin: 2.5rem 0 0 }

  .notice, .warn {
    margin: 0 0 1rem; padding: .6rem .8rem; color: #1a1a1a;
    background: #eef3fb; border-left: 3px solid ${ACCENT};
  }
  .warn { background: #fdeeec; border-left-color: ${DANGER} }

  nav { margin: 0 0 2rem; padding: 0 0 .75rem; border-bottom: 1px solid #e4e7eb }
  nav a { margin-right: 1rem; text-decoration: none }
  nav a.here { font-weight: 600; color: #1a1a1a }

  button, .btn {
    font: inherit; padding: .35rem .8rem; border: 1px solid #c2c8d0;
    border-radius: 4px; background: #fff; color: #1a1a1a; cursor: pointer;
  }
  button.danger { border-color: #d9a19c; color: ${DANGER} }
  a.btn { display: inline-block; text-decoration: none }
  a.primary { background: ${ACCENT}; color: #fff; border-color: ${ACCENT}; padding: .5rem .9rem }

  input, select {
    font: inherit; padding: .45rem .6rem; border: 1px solid #c2c8d0;
    border-radius: 4px; background: #fff;
  }
  input.mono { font-family: ui-monospace, monospace; font-size: .9rem }
  input[readonly] { background: #fff }
  form.row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin: 0 }
  form.row input:not([type=hidden]) { flex: 1 1 18rem }
  label { display: block; font-size: .85rem; color: #555; margin: 0 0 .25rem }
  fieldset { border: 0; padding: 0; margin: 0 0 1rem }

  table { border-collapse: collapse; width: 100%; font-size: .95rem }
  th {
    text-align: left; font-weight: 600; color: #666; font-size: .85rem;
    padding: 0 .75rem .25rem 0;
  }
  td { padding: .5rem .75rem .5rem 0; vertical-align: top }
  tbody tr { border-top: 1px solid #e4e7eb }
  tr.spent { color: #888 }
  td.nowrap, th.nowrap { white-space: nowrap }
  td:last-child, th:last-child { padding-right: 0 }
`;

export interface PageProps {
  title: string;
  heading: string;
  /** One line under the heading: who you are, which site, which tenant. */
  subheading?: string;
  /** `problem` recolours the heading rule. Used by the error pages. */
  tone?: 'normal' | 'problem';
  width?: string;
  nav?: ReactNode;
  children?: ReactNode;
}

export function Page(props: PageProps): ReactNode {
  const { title, heading, subheading, tone = 'normal', width = '34rem', nav, children } = props;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {/* Nothing here should ever be indexed: every page is either a sign-in
            or somebody's own account and audit data. */}
        <meta name="robots" content="noindex" />
        <title>{title}</title>
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>
        <main style={{ maxWidth: width }}>
          {nav}
          <h1 className={tone === 'problem' ? 'problem' : undefined}>{heading}</h1>
          {subheading === undefined ? null : <p className="sub">{subheading}</p>}
          {children}
          <p className="footer">Renkei — Jira work item gateway</p>
        </main>
      </body>
    </html>
  );
}

export function Notice({ children }: { children: ReactNode }): ReactNode {
  return <p className="notice">{children}</p>;
}

export function Warning({ children }: { children: ReactNode }): ReactNode {
  return <p className="warn">{children}</p>;
}

export function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/**
 * The hidden field every state-changing form carries.
 *
 * A component rather than a snippet each page writes, because a form that
 * forgets it is refused at the route — which is the correct outcome and a
 * confusing way to find out. One import makes it hard to leave out.
 */
export function Csrf({ token }: { token: string }): ReactNode {
  return <input type="hidden" name="csrf" value={token} />;
}
