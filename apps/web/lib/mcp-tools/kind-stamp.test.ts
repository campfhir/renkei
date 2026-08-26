/**
 * The read/act stamp. What matters most here is the MERGE: `_meta` already
 * carries widget URIs and `renkei/outcome` on real results, and clobbering
 * it would break interactive previews and failure classification at once —
 * in a way that looks like those regressing rather than like this file
 * being wrong.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { KIND_META_KEY, toolKindOf, withKindStamp } from './kind-stamp';

type Handler = (...args: unknown[]) => unknown;

/** A stand-in for the SDK server, recording what was registered. */
function harness() {
  const handlers = new Map<string, Handler>();
  const stub = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
      return undefined;
    },
    somethingElse() {
      return 'passed through';
    },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a test double standing in for the SDK surface
  const server = stub as unknown as McpServer;
  return { server, handlers, stub };
}

/** Register through the stamp and return the wrapped handler. */
function wrap(annotations: Record<string, unknown> | undefined, handler: Handler): Handler {
  const { server, handlers } = harness();
  const stamped = withKindStamp(server);
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- registerTool is a union across tool shapes
  const register = stamped.registerTool as unknown as (
    name: string,
    config: unknown,
    handler: Handler
  ) => void;
  register('t', { annotations }, handler);
  const wrapped = handlers.get('t');
  if (!wrapped) throw new Error('handler was not registered');
  return wrapped;
}

/** The `_meta` of a result, as a plain record — {} when it has none. */
function metaOf(result: unknown): Record<string, unknown> {
  if (typeof result !== 'object' || result === null) return {};
  const meta: unknown = Reflect.get(result, '_meta');
  return typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? { ...meta } : {};
}

async function kindFrom(annotations: Record<string, unknown> | undefined): Promise<string | null> {
  const result: unknown = await wrap(annotations, () => text())();
  return toolKindOf(metaOf(result));
}

const text = () => ({ content: [{ type: 'text', text: 'ok' }] });

describe('withKindStamp', () => {
  it('stamps a readOnlyHint tool as a read', async () => {
    expect(await kindFrom({ readOnlyHint: true })).toBe('read');
  });

  it('stamps anything else as an act — an absent hint means mutating', async () => {
    // The same conservative reading the capability gate uses. Roughly half
    // the tools declare `readOnlyHint: false`; the rest of the acts declare
    // nothing at all, and must not be mistaken for reads.
    expect(await kindFrom({ readOnlyHint: false })).toBe('act');
    expect(await kindFrom({})).toBe('act');
    expect(await kindFrom(undefined)).toBe('act');
  });

  it('MERGES into an existing _meta rather than replacing it', async () => {
    // Not hypothetical: dozens of Jira and JSM tools return a widget URI in
    // `_meta` via previewToolMeta(), and the failure classifier reads
    // `renkei/outcome` from the same place.
    const result: unknown = await wrap({ readOnlyHint: false }, () => ({
      ...text(),
      _meta: {
        'renkei/outcome': 'not-found',
        'openai/outputTemplate': 'ui://widget/issue-preview',
      },
    }))();
    const meta = metaOf(result);
    expect(meta['renkei/outcome']).toBe('not-found');
    expect(meta['openai/outputTemplate']).toBe('ui://widget/issue-preview');
    expect(meta[KIND_META_KEY]).toBe('act');
  });

  it('leaves the content alone', async () => {
    const result: unknown = await wrap({ readOnlyHint: true }, () => text())();
    expect(Reflect.get(Object(result), 'content')).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('stamps a synchronous handler too', async () => {
    const result: unknown = await wrap({ readOnlyHint: true }, () => text())();
    expect(toolKindOf(metaOf(result))).toBe('read');
  });

  it('lets a throw through unstamped — there is no result to stamp', async () => {
    const wrapped = wrap({ readOnlyHint: false }, () => {
      throw new Error('boom');
    });
    await expect(wrapped()).rejects.toThrow('boom');
  });

  it('leaves a non-object result alone', async () => {
    expect(await wrap({ readOnlyHint: true }, () => 'plain')()).toBe('plain');
  });

  it('registers a non-function handler untouched rather than wrapping it', async () => {
    const { server, handlers } = harness();
    const stamped = withKindStamp(server);
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- deliberately passing the wrong shape
    const register = stamped.registerTool as unknown as (
      name: string,
      config: unknown,
      handler: unknown
    ) => void;
    register('t', { annotations: {} }, 'not a function');
    expect(handlers.get('t')).toBe('not a function');
  });

  it('passes every other member of the server through', () => {
    const { server } = harness();
    expect(Reflect.get(withKindStamp(server), 'somethingElse')()).toBe('passed through');
  });
});

describe('toolKindOf', () => {
  it('returns null for anything that is not a stamp', () => {
    // Null means NOT KNOWN, never "read": a caller that reads the absence as
    // a read under-reports what an agent did, which is the wrong direction.
    expect(toolKindOf(undefined)).toBeNull();
    expect(toolKindOf({})).toBeNull();
    expect(toolKindOf({ [KIND_META_KEY]: 'sideways' })).toBeNull();
  });
});
