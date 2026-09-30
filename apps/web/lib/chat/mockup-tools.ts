/**
 * chat_show_mockup — the model's way to show how something would look:
 * a screen, a component, a layout, an email, a diagram drawn by hand. It
 * writes the design as code — a React component styled with Tailwind, plain
 * HTML and CSS, or an SVG — and the thread draws it inline as a card the
 * person can click to open full screen and zoom (mockup-card.tsx).
 *
 * The tool keeps nothing: the source rides in the call's own input, which
 * the chat already stores, and the route that serves the document
 * (app/api/.../mockups/[toolUseId]) reads it back from there. What the
 * tool does at call time is prove the mockup builds — a React component
 * that does not compile is refused with the compiler's message, so the
 * model fixes it in the same turn instead of the person finding a broken
 * card.
 *
 * Every chat has it, a code project's included. It changes nothing, so it
 * never asks; it is withheld from sub-agents (chat-delegate.ts) only
 * because they have no thread to draw a card in.
 */

import { buildMockupDocument } from '@/lib/mockups/document';
import {
  MOCKUP_CSS_MAX_CHARS,
  MOCKUP_FORMATS,
  MOCKUP_HEIGHT_MAX,
  MOCKUP_HEIGHT_MIN,
  MOCKUP_SOURCE_MAX_CHARS,
  MOCKUP_TOOL,
  MOCKUP_WIDTH_DEFAULT,
  MOCKUP_WIDTH_MAX,
  MOCKUP_WIDTH_MIN,
  parseMockupRequest,
} from '@/lib/mockups/request';
import { errorResult, textResult, type LocalTool } from './local-tools';

export function mockupTools(): LocalTool[] {
  return [
    {
      def: {
        name: MOCKUP_TOOL,
        description:
          'Show the person how something would look: a page, a screen, a component, a form, a ' +
          'dashboard, an email, a diagram drawn by hand. You write it as code and it appears ' +
          'inline in the chat as a live preview; the person can click it to open it full screen ' +
          'and zoom in. Use it whenever a picture would say more than a description — a UI you ' +
          'are about to build, a design option, a layout change. One call shows one screen; call ' +
          'it again for another screen or a revised version (a second call replaces nothing, it ' +
          'adds a card). ' +
          'Formats: "react" — one file whose default export is a component, styled with Tailwind ' +
          'utility classes; hooks work, so tabs, toggles and menus can really work; the only ' +
          'import available is "react". "html" — plain HTML (a fragment, or a whole document) ' +
          'with Tailwind classes and your own css; inline <script> works. "svg" — an <svg> ' +
          'element, for an illustration, icon, logo or hand-drawn diagram. ' +
          'The preview has no network: no remote images, fonts, CDNs or fetches. Draw with ' +
          'Tailwind, CSS gradients and shapes, inline SVG and emoji; use realistic content, not ' +
          'lorem ipsum. Links and forms do not navigate. Design for the width you set: ' +
          `${MOCKUP_WIDTH_DEFAULT} for a desktop page (default), 768 for a tablet, 390 for a phone.`,
        inputSchema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
              description: 'A short name for the card: "Settings page", "Mobile checkout".',
            },
            format: {
              type: 'string',
              enum: [...MOCKUP_FORMATS],
              description:
                'react (a component, Tailwind), html (markup, Tailwind and css), or svg (an image).',
            },
            source: {
              type: 'string',
              description:
                `The code, at most ${MOCKUP_SOURCE_MAX_CHARS} characters. react: a module with ` +
                '`export default function Mockup() { … }`, importing only from "react". html: a ' +
                'fragment or a full document. svg: an <svg> element with a viewBox.',
            },
            css: {
              type: 'string',
              description: `Extra CSS for react or html (Tailwind directives such as @apply and @theme work), at most ${MOCKUP_CSS_MAX_CHARS} characters. Optional.`,
            },
            width: {
              type: 'integer',
              minimum: MOCKUP_WIDTH_MIN,
              maximum: MOCKUP_WIDTH_MAX,
              description: `The viewport width to lay the design out at, in pixels (default ${MOCKUP_WIDTH_DEFAULT}). Use 390 for a phone screen.`,
            },
            height: {
              type: 'integer',
              minimum: MOCKUP_HEIGHT_MIN,
              maximum: MOCKUP_HEIGHT_MAX,
              description:
                'A fixed viewport height in pixels, for a design that fills a screen (h-screen). Omit to let the page be as tall as its content.',
            },
          },
          required: ['title', 'format', 'source'],
        },
      },
      readOnly: true,
      async execute(input) {
        const parsed = parseMockupRequest(input);
        if (!parsed.ok) return errorResult(parsed.message);
        const built = await buildMockupDocument(parsed.request);
        if (!built.ok) return errorResult(built.message);
        const { request } = parsed;
        return textResult(
          `Showed “${request.title}” inline in the chat (${request.format}, laid out ${request.width}px wide). ` +
            'The person can click it to open it full screen and zoom. Say in a sentence or two ' +
            'what it shows and any choice worth calling out; do not paste its code again. To ' +
            'change it, call this tool again with the revised source.'
        );
      },
    },
  ];
}
