/**
 * TypeScript in, sandbox-ready JavaScript out.
 *
 * Cleaner scripts are authored against a typed `email` object, which is
 * what makes autocomplete and red squiggles possible in the editor. QuickJS
 * has no idea what a type annotation is, so the types have to come off
 * before the source reaches it.
 *
 * This is a TYPE STRIP, not a compile: esbuild's `ts` loader erases
 * annotations and leaves everything else byte-identical. That is the whole
 * job — no downlevelling, no polyfills, no module wrapping — and it keeps
 * the compiled output close enough to the source that a stack position in
 * an error message still means something to the person who wrote it.
 *
 * `enum` and parameter properties are the two TypeScript features that
 * emit runtime code rather than erasing. Neither has any place in a
 * 250ms body-transform, and both are rejected below rather than silently
 * producing output that does not match the source.
 */

import { transform } from 'esbuild';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export interface CompiledScript {
  /** What the sandbox runs. Identical to the input when it was already JS. */
  compiled: string;
  /** Whether anything was actually stripped — drives whether we store a copy. */
  transformed: boolean;
}

/** Emits runtime code instead of erasing; see the module note. */
const NON_ERASABLE = [
  { pattern: /(^|\s)(const\s+)?enum\s+[A-Za-z_$]/, name: 'enum' },
  { pattern: /(^|\s)namespace\s+[A-Za-z_$]/, name: 'namespace' },
];

export async function compileCleanerScript(
  source: string
): Promise<Result<CompiledScript, 'SYNTAX' | 'UNSUPPORTED'> & { detail?: string }> {
  for (const feature of NON_ERASABLE) {
    if (feature.pattern.test(source)) {
      return {
        ...err('UNSUPPORTED' as const),
        detail: `${feature.name} is not supported — it would need to emit runtime code, and a cleaner script must be a single expression.`,
      };
    }
  }

  try {
    // Wrapped in parentheses for the same reason the sandbox wraps it: a
    // cleaner script is an EXPRESSION, and esbuild parses its input as a
    // statement list. Unwrapped, `function (email) {}` reads as a function
    // declaration with no name and fails to parse — which would reject
    // every script written in the documented shape.
    const result = await transform(`(${source})`, {
      loader: 'ts',
      target: 'es2020',
      // Comments carry the only documentation a future admin gets.
      legalComments: 'inline',
    });
    // Unwrap again so what is stored looks like what was written. esbuild
    // emits `(<expr>);`; leaving that in would work — the sandbox
    // re-parenthesises — but the stored text is read by people, and
    // gratuitous punctuation makes a diff against the source harder than
    // it needs to be.
    const emitted = result.code.trim().replace(/;+$/, '');
    const compiled =
      emitted.startsWith('(') && emitted.endsWith(')') ? emitted.slice(1, -1).trim() : emitted;
    if (!compiled) {
      return {
        ...err('SYNTAX' as const),
        detail: 'The script compiled to nothing — it must be a function expression.',
      };
    }
    return ok({ compiled, transformed: compiled !== source.trim() });
  } catch (error) {
    const message =
      typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : 'The script could not be parsed.';
    return { ...err('SYNTAX' as const), detail: message.slice(0, 300) };
  }
}
