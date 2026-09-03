/**
 * The sandbox_browser_* tools — a headless browser an agent drives from
 * inside its scratch space (apps/worker-sandbox/src/browser.ts), for the
 * pages no Renkei connector reaches: a vendor portal, a public status
 * page, a form that only exists on the web.
 *
 * The shape is deliberately the same as every other sandbox verb — one
 * named, bounded thing the WORKER does — applied to a page:
 *
 *   navigate → read the snapshot → act on an element by its [eN] ref →
 *   read the snapshot the action answers with → ...
 *
 * sandbox_browser_run folds several of those actions into one call (fill,
 * select, scroll, wait, submit) when the model already has every ref it
 * needs, so a form is one round trip instead of five.
 *
 * A snapshot is not HTML: it is the headings, text and interactive
 * elements a person would see, each control carrying a short ref the
 * worker stamped on the live page. Every action takes a ref, never a CSS
 * selector and never a script, so nothing the model writes is ever
 * evaluated in the page. Each caller gets their own isolated browser
 * context (cookies, storage, tabs) scoped by (tenantId, subject) exactly
 * like their staged files; it closes itself after ten idle minutes.
 *
 * Egress is the worker's concern, not this file's: Chromium runs behind a
 * loopback proxy that refuses private and internal addresses for every
 * connection a page makes, and top-level navigation is https-only.
 * Screenshots are staged as ordinary scratch-space files (same TTL, same
 * quota), so they can be sent onward with sandbox_send_to_upload.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from '../common';
import { errText, fileLine, str, targetOf, textResult } from './shared';
import {
  sbBrowserBack,
  sbBrowserClick,
  sbBrowserClose,
  sbBrowserNavigate,
  sbBrowserPress,
  sbBrowserRun,
  sbBrowserScreenshot,
  sbBrowserScroll,
  sbBrowserSelect,
  sbBrowserSnapshot,
  sbBrowserType,
  clientFailure,
  type WireBrowserPage,
  type WireBrowserStep,
} from '@/lib/sandbox/service-client';

const maxCharsField = z
  .number()
  .int()
  .positive()
  .max(80_000)
  .optional()
  .describe('Cap on the returned snapshot text (default 20000, max 80000).');

const refField = z
  .string()
  .regex(/^e\d{1,5}$/)
  .describe(
    'An element ref from the latest snapshot, e.g. "e12". Refs change whenever the page does.'
  );

const keyField = z
  .string()
  .max(40)
  .regex(/^[A-Za-z0-9]+(\+[A-Za-z0-9]+){0,3}$/)
  .describe('A key name, optionally with modifiers joined by "+".');

const scrollFields = {
  ref: refField.optional().describe('Scroll this element into view instead of scrolling the page.'),
  direction: z.enum(['up', 'down']).optional().describe('Page scroll direction (default down).'),
  amount: z
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe('Pixels to scroll the page (default 720, most of a screen).'),
};

/** One sandbox_browser_run step; mirrors the single verbs one for one. */
const stepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: z.string().url() }),
  z.object({ kind: z.literal('click'), ref: refField }),
  z.object({
    kind: z.literal('type'),
    ref: refField,
    text: z.string().max(10_000),
    submit: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('select'),
    ref: refField,
    values: z.array(z.string().max(200)).min(1).max(50),
  }),
  z.object({ kind: z.literal('press'), key: keyField }),
  z.object({ kind: z.literal('scroll'), ...scrollFields }),
  z.object({
    kind: z.literal('wait'),
    ms: z.number().int().positive().max(10_000).optional().describe('Pause this long.'),
    text: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Wait (up to 10s) until this text is visible on the page.'),
  }),
  z.object({ kind: z.literal('back') }),
]);

function maxCharsOf(args: Record<string, unknown>): number | undefined {
  return typeof args.maxChars === 'number' ? args.maxChars : undefined;
}

function pageResult(page: WireBrowserPage) {
  return textResult(page.snapshot);
}

export function registerSandboxBrowserTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'sandbox_browser_navigate',
    {
      title: 'Sandbox · Act — Open a web page in your browser',
      description:
        'Open an https:// URL in your own headless browser session and return a snapshot of the ' +
        'page: its title, URL, headings, text, and every link and form control, each control ' +
        'tagged with a ref like [e12]. Use the refs with sandbox_browser_click / _type / _select; ' +
        'every action answers with a fresh snapshot, so you rarely need sandbox_browser_snapshot ' +
        'between actions. The session keeps cookies and history until sandbox_browser_close or ' +
        'ten idle minutes. Private/internal addresses are refused (no localhost, no internal ' +
        'network, no cloud metadata) and pages are never allowed to reach them either. Use this ' +
        'for sites with no Renkei connector; for a plain file download use sandbox_download_url.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        url: z.string().url().describe('An https:// URL to open.'),
        maxChars: maxCharsField,
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const opened = await sbBrowserNavigate(target, {
        url: str(args.url),
        maxChars: maxCharsOf(args),
      });
      if (!opened.ok) return errText(clientFailure(opened.err).message);
      return pageResult(opened.val);
    }
  );

  server.registerTool(
    'sandbox_browser_snapshot',
    {
      title: 'Sandbox · Read — Read the page currently open in your browser',
      description:
        'A fresh snapshot of the page your browser session is on: title, URL, headings, text, ' +
        'and interactive elements with [eN] refs. Ask for a larger maxChars when a snapshot ' +
        'says it was truncated. Requires a page opened with sandbox_browser_navigate.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ maxChars: maxCharsField }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const read = await sbBrowserSnapshot(target, { maxChars: maxCharsOf(args) });
      if (!read.ok) return errText(clientFailure(read.err).message);
      return pageResult(read.val);
    }
  );

  server.registerTool(
    'sandbox_browser_click',
    {
      title: 'Sandbox · Act — Click an element on the open page',
      description:
        'Click a link, button, checkbox, tab or any other element by its [eN] ref from the ' +
        'latest snapshot, wait for the page to settle (a navigation, a popup, a menu opening), ' +
        'and return the new snapshot. If a ref is reported stale, take a new snapshot first.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({ ref: refField, maxChars: maxCharsField }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const clicked = await sbBrowserClick(target, {
        ref: str(args.ref),
        maxChars: maxCharsOf(args),
      });
      if (!clicked.ok) return errText(clientFailure(clicked.err).message);
      return pageResult(clicked.val);
    }
  );

  server.registerTool(
    'sandbox_browser_type',
    {
      title: 'Sandbox · Act — Type into a field on the open page',
      description:
        'Replace the contents of a text field, search box, textarea or editable region (by its ' +
        '[eN] ref) with the given text; set submit to also press Enter, which submits most ' +
        'forms. Returns the new snapshot. Never type credentials or secrets you were not ' +
        'explicitly given for this task.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        ref: refField,
        text: z.string().max(10_000).describe('The text the field should contain afterwards.'),
        submit: z.boolean().optional().describe('Press Enter after typing (default false).'),
        maxChars: maxCharsField,
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const typed = await sbBrowserType(target, {
        ref: str(args.ref),
        text: str(args.text),
        submit: args.submit === true,
        maxChars: maxCharsOf(args),
      });
      if (!typed.ok) return errText(clientFailure(typed.err).message);
      return pageResult(typed.val);
    }
  );

  server.registerTool(
    'sandbox_browser_select',
    {
      title: 'Sandbox · Act — Choose an option in a dropdown on the open page',
      description:
        'Pick one or more options of a <select> (a combobox or listbox in the snapshot) by ' +
        'label or value. Returns the new snapshot.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        ref: refField,
        values: z
          .array(z.string().max(200))
          .min(1)
          .max(50)
          .describe('Option labels or values to select.'),
        maxChars: maxCharsField,
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const values = Array.isArray(args.values) ? args.values.map(str) : [];
      const selected = await sbBrowserSelect(target, {
        ref: str(args.ref),
        values,
        maxChars: maxCharsOf(args),
      });
      if (!selected.ok) return errText(clientFailure(selected.err).message);
      return pageResult(selected.val);
    }
  );

  server.registerTool(
    'sandbox_browser_press_key',
    {
      title: 'Sandbox · Act — Press a key on the open page',
      description:
        'Press one key (Enter, Escape, Tab, ArrowDown, PageDown, Control+a, ...) in the page, ' +
        'for dismissing dialogs, moving through menus, or scrolling. Returns the new snapshot.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({ key: keyField, maxChars: maxCharsField }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const pressed = await sbBrowserPress(target, {
        key: str(args.key),
        maxChars: maxCharsOf(args),
      });
      if (!pressed.ok) return errText(clientFailure(pressed.err).message);
      return pageResult(pressed.val);
    }
  );

  server.registerTool(
    'sandbox_browser_scroll',
    {
      title: 'Sandbox · Act — Scroll the open page',
      description:
        'Scroll the page down (default) or up by a number of pixels, or bring one element (by ' +
        'its [eN] ref) into view — for long pages, lazy-loaded lists, and elements that must ' +
        'be on screen before they can be clicked. Returns the new snapshot.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({ ...scrollFields, maxChars: maxCharsField }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const scrolled = await sbBrowserScroll(target, {
        ...(typeof args.ref === 'string' ? { ref: args.ref } : {}),
        ...(args.direction === 'up' || args.direction === 'down'
          ? { direction: args.direction }
          : {}),
        ...(typeof args.amount === 'number' ? { amount: args.amount } : {}),
        maxChars: maxCharsOf(args),
      });
      if (!scrolled.ok) return errText(clientFailure(scrolled.err).message);
      return pageResult(scrolled.val);
    }
  );

  server.registerTool(
    'sandbox_browser_run',
    {
      title: 'Sandbox · Act — Run several browser steps in one call',
      description:
        'Execute an ordered list of steps on the open page without a round trip between ' +
        'them — e.g. type into three fields, select an option, scroll, click submit, then wait ' +
        'for a confirmation text — and return one snapshot of where the page ended up. Step ' +
        'kinds: navigate (url), click (ref), type (ref, text, submit?), select (ref, values), ' +
        'press (key), scroll (ref? | direction?, amount?), wait (ms? and/or text?), back. Steps ' +
        'that load a page wait for it before the next step runs. Refs must come from the ' +
        'snapshot you already have, so put actions on a NEW page (after a link or submit) ' +
        'in the next call. The run stops at the first failing step and tells you which one, ' +
        'how many completed, and what the page shows now. At most 20 steps and 20s of ' +
        'explicit waiting per run.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        steps: z.array(stepSchema).min(1).max(20).describe('Steps to run, in order.'),
        maxChars: maxCharsField,
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      // Cast: the zod schema above already validated the shape.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      const steps = (Array.isArray(args.steps) ? args.steps : []) as WireBrowserStep[];
      const ran = await sbBrowserRun(target, { steps, maxChars: maxCharsOf(args) });
      if (!ran.ok) return errText(clientFailure(ran.err).message);
      const { completed, page, failed } = ran.val;
      const snapshot = page ? `\n\n${page.snapshot}` : '';
      if (failed) {
        const before =
          completed === 0 ? 'Nothing ran before it.' : `${completed} step(s) before it completed.`;
        return errText(
          `Step ${failed.index + 1} (${failed.kind}) failed: ${failed.message} ${before}${snapshot}`
        );
      }
      return textResult(`Completed ${completed} step(s).${snapshot}`);
    }
  );

  server.registerTool(
    'sandbox_browser_back',
    {
      title: 'Sandbox · Act — Go back to the previous page',
      description: 'Navigate back in the browser session history and return the snapshot.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({ maxChars: maxCharsField }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const back = await sbBrowserBack(target, { maxChars: maxCharsOf(args) });
      if (!back.ok) return errText(clientFailure(back.err).message);
      return pageResult(back.val);
    }
  );

  server.registerTool(
    'sandbox_browser_screenshot',
    {
      title: 'Sandbox · Act — Screenshot the open page into your scratch space',
      description:
        'Take a PNG screenshot of the open page and stage it as a scratch-space file (it counts ' +
        'against your quota and expires like any staged file). The result names the file id; ' +
        'send it onward with sandbox_send_to_upload or list it with sandbox_list_files. The ' +
        'image is not returned inline — read the page with a snapshot instead.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        fullPage: z
          .boolean()
          .optional()
          .describe('Capture the whole scrollable page (default: the viewport).'),
        filename: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe('Name to store as (default screenshot-<time>.png).'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const shot = await sbBrowserScreenshot(target, {
        fullPage: args.fullPage === true,
        filename: str(args.filename) || undefined,
      });
      if (!shot.ok) return errText(clientFailure(shot.err).message);
      return textResult(`Staged ${fileLine(shot.val.file)} — screenshot of ${shot.val.url}`);
    }
  );

  server.registerTool(
    'sandbox_browser_close',
    {
      title: 'Sandbox · Act — Close your browser session',
      description:
        'Close the browser session (its pages, cookies and history). It would close on its own ' +
        'after ten idle minutes; close it early when you are done with a site.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({}),
    },
    async () => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);
      const closed = await sbBrowserClose(target);
      if (!closed.ok) return errText(clientFailure(closed.err).message);
      return textResult(
        closed.val.closed ? 'Browser session closed.' : 'No browser session was open.'
      );
    }
  );
}
