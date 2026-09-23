/**
 * The grammars a chat code block can be coloured with. lowlight's common
 * set covers the languages a reply is likely to carry — SQL, TypeScript,
 * JavaScript, JSON, YAML, XML/HTML, shell, CSS, Python, Go, Java and the
 * rest — and a few more are added that an integration shop meets daily:
 * Dockerfiles, PowerShell, Windows batch files, raw HTTP exchanges, Java
 * .properties files, Protobuf, nginx configuration and Groovy. Every grammar here ships in
 * the bundle; nothing is fetched. The words a fence may use for them
 * live in lib/chat/code-languages.ts.
 */

import { common, createLowlight } from 'lowlight';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import dos from 'highlight.js/lib/languages/dos';
import groovy from 'highlight.js/lib/languages/groovy';
import http from 'highlight.js/lib/languages/http';
import nginx from 'highlight.js/lib/languages/nginx';
import powershell from 'highlight.js/lib/languages/powershell';
import properties from 'highlight.js/lib/languages/properties';
import protobuf from 'highlight.js/lib/languages/protobuf';
import { CODE_ALIASES } from './code-languages';

export const CODE_GRAMMARS = {
  ...common,
  dockerfile,
  dos,
  groovy,
  http,
  nginx,
  powershell,
  properties,
  protobuf,
};

let shared: ReturnType<typeof createLowlight> | null = null;

/** One highlighter for the panes outside Markdown, built on first use. */
export function codeHighlighter(): ReturnType<typeof createLowlight> {
  if (!shared) {
    shared = createLowlight(CODE_GRAMMARS);
    shared.registerAlias(CODE_ALIASES);
  }
  return shared;
}
