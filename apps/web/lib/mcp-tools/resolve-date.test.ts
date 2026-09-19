/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * resolve_date: the tool a chat reaches for instead of hand-calculating a
 * relative date. It must resolve deterministically (a fixed "now" makes the
 * assertions exact regardless of when the suite runs), refuse a lone
 * "amount" with no "unit", and hand back a date-chip object an agent
 * author can paste straight into a step.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPToolContext } from './common';
import { registerResolveDateTool } from './resolve-date';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}>;

const context = (): MCPToolContext =>
  ({
    tenantId: 'tenant-1',
    accountId: 'acct-1',
    subject: 'subject-1',
  }) as unknown as MCPToolContext;

async function resolveHandler(): Promise<ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  registerResolveDateTool(server, context());
  const handler = handlers.get('resolve_date');
  if (!handler) throw new Error('resolve_date was not registered');
  return handler;
}

describe('resolve_date', () => {
  it('resolves a signed amount+unit against the given timezone', async () => {
    const handler = await resolveHandler();

    const result = await handler({ timezone: 'UTC', amount: -3, unit: 'day' });

    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('UTC');
    expect(text).toContain('Date-chip for an agent step:');
    expect(text).toContain(
      JSON.stringify({ t: 'date', amount: -3, unit: 'day', timezone: 'UTC' })
    );
  });

  it('carries atTime and boundary through into the returned chip', async () => {
    const handler = await resolveHandler();

    const result = await handler({
      timezone: 'America/Los_Angeles',
      amount: 1,
      unit: 'day',
      atTime: '09:00',
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain(
      JSON.stringify({
        t: 'date',
        amount: 1,
        unit: 'day',
        timezone: 'America/Los_Angeles',
        atTime: '09:00',
      })
    );
  });

  it('defaults to now/today when amount and unit are both omitted', async () => {
    const handler = await resolveHandler();

    const result = await handler({ timezone: 'UTC' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain(
      JSON.stringify({ t: 'date', amount: 0, unit: 'day', timezone: 'UTC' })
    );
  });

  it('refuses an amount with no unit rather than guessing one', async () => {
    const handler = await resolveHandler();

    const result = await handler({ timezone: 'UTC', amount: -1 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('needs a unit');
  });

  it('reports an unresolvable timezone instead of a plausible-looking wrong answer', async () => {
    const handler = await resolveHandler();

    const result = await handler({ timezone: 'Not/AZone' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Not/AZone');
  });
});
