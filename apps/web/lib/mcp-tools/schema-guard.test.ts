jest.mock('@/lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  },
}));

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { logger } from '@/lib/logger';
import { withSchemaGuard } from './schema-guard';

function harness() {
  const registered: string[] = [];
  const stub = {
    registerTool(name: string) {
      registered.push(name);
      return undefined;
    },
  };
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a test double standing in for the SDK surface
  const server = withSchemaGuard(stub as unknown as McpServer);
  return { server, registered };
}

describe('withSchemaGuard', () => {
  it('registers a tool whose schema converts', () => {
    const { server, registered } = harness();
    server.registerTool(
      'good',
      { inputSchema: z.object({ limit: z.number().optional() }) },
      jest.fn()
    );
    server.registerTool('no_input', {}, jest.fn());
    expect(registered).toEqual(['good', 'no_input']);
  });

  it('leaves out a tool whose schema holds a function, names it, and keeps the rest', () => {
    const { server, registered } = harness();
    const factory = (max: number) => z.number().max(max).optional();
    server.registerTool(
      'broken',
      // The mistake this guards against: the factory passed uncalled.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      { inputSchema: z.object({ limit: factory as unknown as z.ZodType }) },
      jest.fn()
    );
    server.registerTool('fine', { inputSchema: z.object({ limit: factory(5) }) }, jest.fn());
    expect(registered).toEqual(['fine']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('left out'),
      expect.objectContaining({ tool: 'broken' })
    );
  });
});
