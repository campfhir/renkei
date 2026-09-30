/**
 * A mockup as the one HTML document the thread's iframe loads. Server
 * only: React mockups are compiled here (esbuild), and the Tailwind
 * runtime is read off disk.
 *
 * The model writes one of three things — a React component styled with
 * Tailwind, plain HTML (Tailwind classes and its own CSS both work), or an
 * SVG — and gets back a document that needs nothing from the network:
 * Tailwind's browser build and, for React, the React runtime are inlined,
 * so a mockup renders the same offline and behind the organization's
 * proxy, and nothing it loads can leave the page.
 *
 * The document is untrusted code (the model wrote it, possibly from
 * text an attacker planted in a ticket), so it runs locked down twice
 * over: the route serves it with `MOCKUP_CSP` — no network of any kind, no
 * remote images, and `sandbox` so it has an opaque origin even if the URL
 * is opened directly — and the thread frames it with `sandbox="allow-scripts"`
 * and nothing else. Scripts are allowed because an interactive mockup (tabs,
 * a menu that opens) shows more than a still one; nothing they can reach is
 * worth having.
 *
 * A small script the host controls rides inside every document
 * (`HOST_SCRIPT`): it reports the page's height so the card can fit it,
 * forwards zoom and Escape so the fullscreen viewer works while the
 * mockup has focus, and stops links and forms from navigating the frame.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build, type BuildFailure, type Message } from 'esbuild';
import { MOCKUP_MESSAGE_SOURCE } from './message';
import type { MockupRequest } from './request';

export type MockupBuild = { ok: true; html: string } | { ok: false; message: string };

/** What the mockup document may do: run its own script and style, and nothing that leaves the page. */
export const MOCKUP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'sandbox allow-scripts',
].join('; ');

// Resolved from the app's own directory — the same place `next start`
// runs from — so the packages are found the way the app finds them.
const fromApp = createRequire(join(process.cwd(), 'package.json'));

let tailwindRuntime: string | null = null;
function tailwindSource(): string {
  tailwindRuntime ??= readFileSync(fromApp.resolve('@tailwindcss/browser'), 'utf8');
  return tailwindRuntime;
}

/** A script body safe to sit inside a <script> element. */
function inlineScript(js: string): string {
  return js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

const HOST_SCRIPT = `
(function () {
  var TAG = ${JSON.stringify(MOCKUP_MESSAGE_SOURCE)};
  function send(message) {
    message.source = TAG;
    try { parent.postMessage(message, '*'); } catch (e) {}
  }
  var lastHeight = -1;
  var queued = false;
  function heightNow() {
    var body = document.body;
    if (!body) return 0;
    return Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, body.scrollHeight));
  }
  function report() {
    queued = false;
    var height = heightNow();
    if (height === lastHeight) return;
    lastHeight = height;
    send({ type: 'size', height: height });
  }
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(report);
  }
  window.addEventListener('load', schedule);
  window.addEventListener('resize', schedule);
  if (typeof ResizeObserver === 'function') {
    var observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    document.addEventListener('DOMContentLoaded', function () { observer.observe(document.body); });
  }
  if (typeof MutationObserver === 'function') {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  }
  schedule();

  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (link && (link.getAttribute('href') || '').charAt(0) !== '#') event.preventDefault();
  }, true);
  document.addEventListener('submit', function (event) { event.preventDefault(); }, true);

  window.addEventListener('wheel', function (event) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    send({ type: 'zoom', deltaY: event.deltaY });
  }, { passive: false });
  window.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { send({ type: 'escape' }); return; }
    if (!event.ctrlKey && !event.metaKey) return;
    if (event.key === '+' || event.key === '=') { event.preventDefault(); send({ type: 'zoom-step', direction: 1 }); }
    else if (event.key === '-') { event.preventDefault(); send({ type: 'zoom-step', direction: -1 }); }
    else if (event.key === '0') { event.preventDefault(); send({ type: 'zoom-step', direction: 0 }); }
  });

  function fail(text) {
    var box = document.getElementById('renkei-mockup-error');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'renkei-mockup-error';
      box.setAttribute('style', 'margin:0;padding:12px 16px;background:#fef2f2;color:#991b1b;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;border-bottom:1px solid #fecaca');
      document.body.insertBefore(box, document.body.firstChild);
    }
    box.textContent = 'This mockup hit an error: ' + text;
    schedule();
  }
  window.addEventListener('error', function (event) { fail(event.message || 'unknown error'); });
  window.addEventListener('unhandledrejection', function (event) {
    fail(String(event.reason && event.reason.message ? event.reason.message : event.reason));
  });
})();
`;

/** Under Tailwind's own layers, on a white page: mockups are drawn for one, whatever the chat's theme. */
const BASE_CSS =
  ':root{color-scheme:light}html,body{margin:0;background:#fff;color:#111827}body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}';

const SVG_CSS = 'svg{display:block;max-width:100%;height:auto}';

// ── React ────────────────────────────────────────────────────────────────

/** Where the compiled component finds React: the runtime bundle sets it before the component runs. */
const HOST_GLOBAL = '__RENKEI_MOCKUP__';

const HOST_MODULES: Record<string, string> = {
  react: `module.exports = window.${HOST_GLOBAL}.React;`,
  'react/jsx-runtime': `module.exports = window.${HOST_GLOBAL}.jsx;`,
  'react/jsx-dev-runtime': `module.exports = window.${HOST_GLOBAL}.jsx;`,
};

let reactRuntime: Promise<string> | null = null;

/** React and its DOM renderer, once per process, exposed on the page for the component to use. */
function reactRuntimeSource(): Promise<string> {
  reactRuntime ??= build({
    stdin: {
      contents: [
        "import * as React from 'react';",
        "import * as jsx from 'react/jsx-runtime';",
        "import { createRoot } from 'react-dom/client';",
        `window.${HOST_GLOBAL} = { React, jsx, createRoot };`,
      ].join('\n'),
      resolveDir: process.cwd(),
      sourcefile: 'mockup-runtime.js',
    },
    bundle: true,
    minify: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  }).then(
    (result) => result.outputFiles[0].text,
    (error: unknown) => {
      reactRuntime = null;
      throw error;
    }
  );
  return reactRuntime;
}

function notAvailable(path: string): string {
  return `Cannot import "${path}": a mockup is one self-contained file and only "react" is available. Inline anything else — icons as SVG, data as constants.`;
}

function describeMessage(message: Message): string {
  const at = message.location ? `line ${message.location.line}:${message.location.column} — ` : '';
  return `${at}${message.text}`;
}

function isBuildFailure(error: unknown): error is BuildFailure {
  return error instanceof Error && 'errors' in error && Array.isArray(error.errors);
}

const compiled = new Map<string, string>();
const COMPILED_KEEP = 40;

/** The component's source as one script that defines `__mockup.default`, or what is wrong with it. */
async function compileComponent(
  source: string
): Promise<{ ok: true; js: string } | { ok: false; message: string }> {
  if (!/\bexport\s+default\b/.test(source)) {
    return {
      ok: false,
      message:
        'A react mockup must `export default` its component — for example `export default function Mockup() { return <div className="p-6">…</div>; }`.',
    };
  }
  const key = createHash('sha256').update(source).digest('hex');
  const known = compiled.get(key);
  if (known !== undefined) return { ok: true, js: known };
  try {
    const result = await build({
      stdin: {
        contents: source,
        loader: 'tsx',
        resolveDir: process.cwd(),
        sourcefile: 'mockup.tsx',
      },
      bundle: true,
      write: false,
      metafile: true,
      format: 'iife',
      globalName: '__mockup',
      platform: 'browser',
      target: 'es2020',
      jsx: 'automatic',
      logLevel: 'silent',
      plugins: [
        {
          name: 'mockup-imports',
          setup(hooks) {
            // Only React is on the page. Anything else — a package, another
            // file, a URL — would be a network fetch or a file read the
            // mockup has no business making, and is said so plainly.
            hooks.onResolve({ filter: /.*/ }, (args) => {
              if (args.kind === 'entry-point') return null;
              if (args.path in HOST_MODULES) return { path: args.path, namespace: 'host' };
              return {
                errors: [{ text: notAvailable(args.path) }],
              };
            });
            hooks.onLoad({ filter: /.*/, namespace: 'host' }, (args) => ({
              contents: HOST_MODULES[args.path],
              loader: 'js',
            }));
          },
        },
      ],
    });
    // esbuild leaves a URL import (https://…) as an external import without
    // asking the resolver above; the page's CSP would refuse to load it, but a
    // mockup that only works by failing quietly is not one to show.
    for (const input of Object.values(result.metafile.inputs)) {
      const external = input.imports.find((entry) => entry.external === true);
      if (external) return { ok: false, message: notAvailable(external.path) };
    }
    const js = result.outputFiles[0].text;
    if (compiled.size >= COMPILED_KEEP) {
      const oldest = compiled.keys().next();
      if (!oldest.done) compiled.delete(oldest.value);
    }
    compiled.set(key, js);
    return { ok: true, js };
  } catch (error) {
    if (isBuildFailure(error) && error.errors.length > 0) {
      return {
        ok: false,
        message: `The component did not compile:\n${error.errors.slice(0, 5).map(describeMessage).join('\n')}`,
      };
    }
    return {
      ok: false,
      message: `The component did not compile: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const MOUNT_SCRIPT = `
(function () {
  var host = window.${HOST_GLOBAL};
  var Component = typeof __mockup === 'object' && __mockup ? __mockup.default : undefined;
  if (typeof Component !== 'function') throw new Error('The default export is not a component.');
  host.createRoot(document.getElementById('root')).render(host.React.createElement(Component));
})();
`;

// ── Assembly ─────────────────────────────────────────────────────────────

function head(request: MockupRequest, extra = ''): string {
  const tailwind = request.format !== 'svg';
  return [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light">',
    `<title>${escapeText(request.title)}</title>`,
    `<style>${BASE_CSS}${request.format === 'svg' ? SVG_CSS : ''}</style>`,
    tailwind ? `<script>${inlineScript(tailwindSource())}</script>` : '',
    // Tailwind's browser build reads this: plain CSS passes through it, and
    // @apply, @theme and the rest of the directives work as in a project.
    request.css
      ? `<style type="${tailwind ? 'text/tailwindcss' : 'text/css'}">${request.css.replace(/<\/style/gi, '<\\/style')}</style>`
      : '',
    extra,
  ].join('');
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The document for an HTML source — a whole page, or just what would sit in its <body>. */
function htmlDocument(request: MockupRequest): string {
  const headHtml = head(request);
  const tail = `<script>${inlineScript(HOST_SCRIPT)}</script>`;
  const { source } = request;
  if (/<html[\s>]/i.test(source)) {
    let out = source;
    out = /<head[\s>]/i.test(out)
      ? out.replace(/<head(\s[^>]*)?>/i, (open) => `${open}${headHtml}`)
      : out.replace(/<html(\s[^>]*)?>/i, (open) => `${open}<head>${headHtml}</head>`);
    out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${tail}</body>`) : `${out}${tail}`;
    return /^\s*<!doctype/i.test(out) ? out : `<!doctype html>${out}`;
  }
  return `<!doctype html><html><head>${headHtml}</head><body>${source}${tail}</body></html>`;
}

export async function buildMockupDocument(request: MockupRequest): Promise<MockupBuild> {
  if (request.format === 'react') {
    const component = await compileComponent(request.source);
    if (!component.ok) return component;
    const runtime = await reactRuntimeSource();
    return {
      ok: true,
      html:
        `<!doctype html><html><head>${head(request)}</head>` +
        `<body><div id="root"></div>` +
        `<script>${inlineScript(HOST_SCRIPT)}</script>` +
        `<script>${inlineScript(runtime)}</script>` +
        `<script>${inlineScript(component.js)}</script>` +
        `<script>${inlineScript(MOUNT_SCRIPT)}</script></body></html>`,
    };
  }
  if (request.format === 'svg') {
    return {
      ok: true,
      html:
        `<!doctype html><html><head>${head(request)}</head><body>${request.source}` +
        `<script>${inlineScript(HOST_SCRIPT)}</script></body></html>`,
    };
  }
  return { ok: true, html: htmlDocument(request) };
}
