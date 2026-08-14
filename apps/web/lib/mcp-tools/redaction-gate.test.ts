/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The redaction gate.
 *
 * The properties worth pinning are about restraint. It must filter the text a
 * model sees, and otherwise change nothing: not the call, not the arguments,
 * not the result's shape, not whether an error is an error. And when redaction
 * itself breaks it must not hand over the unfiltered result, because a caller
 * cannot tell a filtered result from an unfiltered one.
 */

jest.mock('@/lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  secure: (value: unknown) => value,
}));

import type { McpServer } from '@modelcontextprotocol/server';
import { createPseudonymizer, deriveRedactionKey, DEFAULT_MCP_POLICY } from '@renkei/redaction';
import { withRedaction, type RedactionContext } from './redaction-gate';

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
type LooseServer = { registerTool: (name: string, config: unknown, handler?: Handler) => void };

const context = (overrides: Partial<RedactionContext> = {}): RedactionContext => ({
  tenantId: 'tenant-1',
  detectors: ['ssn', 'card', 'mrn', 'dob'],
  mrnPatterns: [],
  policy: DEFAULT_MCP_POLICY,
  pseudonymizer: createPseudonymizer(deriveRedactionKey(Buffer.from('k'.repeat(32))), 'tenant-1'),
  ...overrides,
});

function harness(ctx: RedactionContext = context()) {
  const registered = new Map<string, Handler | undefined>();
  const raw = {
    registerTool: (name: string, _config: unknown, handler?: Handler) => {
      registered.set(name, handler);
    },
  } as unknown as McpServer;
  const server = withRedaction(raw, ctx) as unknown as LooseServer;
  return { server, registered };
}

const text = (result: unknown): string => {
  const content = (result as { content?: { text?: string }[] }).content;
  return content?.[0]?.text ?? '';
};

describe('withRedaction', () => {
  it('replaces identifiers in the text a tool returns', async () => {
    const { server, registered } = harness();
    server.registerTool('jira_get_issue', {}, async () => ({
      content: [{ type: 'text', text: 'Member SSN 123-45-6789, MRN: 4417732.' }],
    }));

    const result = await registered.get('jira_get_issue')!({});
    expect(text(result)).not.toContain('123-45-6789');
    expect(text(result)).not.toContain('4417732');
    expect(text(result)).toMatch(/\[SSN-[0-9a-f]{8}\]/);
  });

  it('returns text with nothing to redact completely unchanged', async () => {
    const { server, registered } = harness();
    const original = { content: [{ type: 'text', text: 'PROJ-1 deployed 2026-08-13.' }] };
    server.registerTool('jira_get_issue', {}, async () => original);

    // Identity, not just equality: the common case must not even rebuild the
    // object, since this runs on every result of every tool.
    expect(await registered.get('jira_get_issue')!({})).toBe(original);
  });

  it('lets the call proceed and never blocks it', async () => {
    const { server, registered } = harness();
    const calls: unknown[] = [];
    server.registerTool('jira_search_issues', {}, async (args) => {
      calls.push(args);
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    await registered.get('jira_search_issues')!({ jql: 'project = ENG' });
    // The tool ran, with its arguments untouched — this filters results, it
    // does not gate access.
    expect(calls).toEqual([{ jql: 'project = ENG' }]);
  });

  it('preserves isError', async () => {
    const { server, registered } = harness();
    server.registerTool('outlook_send_mail', {}, async () => ({
      content: [{ type: 'text', text: 'nope' }],
      isError: true,
    }));

    const result = await registered.get('outlook_send_mail')!({});
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('lets a throwing tool throw', async () => {
    const { server, registered } = harness();
    server.registerTool('zoom_get_transcript', {}, async () => {
      throw new Error('boom');
    });
    await expect(registered.get('zoom_get_transcript')!({})).rejects.toThrow('boom');
  });

  it('leaves non-text content blocks alone', async () => {
    const { server, registered } = harness();
    server.registerTool('some_tool', {}, async () => ({
      content: [
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'text', text: 'SSN 123-45-6789' },
      ],
    }));

    const result = await registered.get('some_tool')!({});
    const content = (result as { content: Record<string, unknown>[] }).content;
    // Untouched rather than dropped: pattern matching cannot reach inside an
    // image, and discarding it would lose what the caller asked for.
    expect(content[0]).toEqual({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
    expect(content[1]?.text).not.toContain('123-45-6789');
  });

  it('passes through a result shape it does not recognise', async () => {
    const { server, registered } = harness();
    const odd = { somethingElse: true };
    server.registerTool('weird', {}, async () => odd);
    expect(await registered.get('weird')!({})).toBe(odd);
  });

  it('withholds rather than leaks when redaction itself fails', async () => {
    // The dangerous branch. A caller cannot distinguish a filtered result from
    // an unfiltered one, so falling back to "return it raw" would quietly ship
    // the exact data this exists to remove.
    const exploding = context({
      pseudonymizer: {
        anonymize: () => {
          throw new Error('kaboom');
        },
        mask: () => '',
        strike: () => '',
      },
    });
    const { server, registered } = harness(exploding);
    server.registerTool('jira_get_issue', {}, async () => ({
      content: [{ type: 'text', text: 'SSN 123-45-6789' }],
    }));

    const result = await registered.get('jira_get_issue')!({});
    expect(text(result)).not.toContain('123-45-6789');
    expect(text(result)).toContain('could not be filtered');
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('honours the detector set it is given', async () => {
    const { server, registered } = harness(context({ detectors: ['mrn'] }));
    server.registerTool('t', {}, async () => ({
      content: [{ type: 'text', text: 'SSN 123-45-6789 and MRN: 4417732' }],
    }));

    const result = await registered.get('t')!({});
    // SSN detection is switched off for this org, so it survives; the MRN does not.
    expect(text(result)).toContain('123-45-6789');
    expect(text(result)).not.toContain('4417732');
  });

  it('passes a registration with no handler straight through', () => {
    const { server, registered } = harness();
    expect(() => server.registerTool('weird_tool', {})).not.toThrow();
    expect(registered.get('weird_tool')).toBeUndefined();
  });
});
