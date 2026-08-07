/**
 * Turning an element into a response body.
 *
 * `renderToStaticMarkup` rather than `renderToString`: the difference is the
 * hydration bookkeeping React adds for a client that is going to take over, and
 * no client here ever does. Nothing is shipped to the browser but HTML.
 *
 * Rendering is synchronous and complete before a status code is chosen, which is
 * what lets a route decide between 200 and 403 from the same page function
 * rather than streaming and discovering a problem halfway down.
 */

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Page } from './layout.js';

/** The doctype is not part of the element tree, so it is prepended here. */
export function renderPage(element: ReactNode): string {
  return `<!doctype html>\n${renderToStaticMarkup(element)}\n`;
}

/**
 * The pages that exist because something went wrong before there was a
 * validated redirect URI to send an error to, so the person in the browser is
 * the only one who can be told.
 */
export function errorPage(heading: string, detail: string): string {
  return renderPage(
    <Page title="Renkei — problem" heading={heading} tone="problem">
      <p>{detail}</p>
    </Page>,
  );
}
