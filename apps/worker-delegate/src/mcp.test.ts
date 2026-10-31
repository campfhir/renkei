/**
 * Discovery never follows a redirect into an address the guard refuses: a
 * hostile public MCP server that answers 30x (to the cloud metadata
 * address, localhost) is stopped before the delegate dials it. Memory
 * store, scripted network.
 */

import type { ServerResponse } from 'node:http';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import { createServer } from '@renkei/connector-mcp';
import { McpPreparer } from './mcp';

const ORIGIN = 'https://mcp.example.test';
const REDIRECT = 'https://renkei.example.test/api/oauth/callback';

/** A ServerResponse that only remembers what sendJson wrote. */
function capture(): { response: ServerResponse; answer: () => { status: number; body: string } } {
  let status = 0;
  let payload = '';
  const response = {
    writeHead(code: number) {
      status = code;
    },
    end(text: string) {
      payload = text;
    },
  };
  return {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a stand-in with the two methods sendJson calls
    response: response as unknown as ServerResponse,
    answer: () => ({ status, body: payload }),
  };
}

const publicOnly = async (url: string): Promise<void> => {
  if (new URL(url).hostname.endsWith('.example.test')) return;
  throw new Error('not a public https address');
};

describe('mcp/prepare redirects', () => {
  const requests: string[] = [];
  const key = parseEncryptionKey(Buffer.alloc(32, 7).toString('base64'));
  if (!key.ok) throw new Error('key');

  beforeEach(() => {
    registerDataStore(createMemoryDataStore());
    requests.length = 0;
  });
  afterEach(() => resetDataStore());

  async function prepareAgainst(script: (url: string) => Response) {
    const fetchImpl: typeof fetch = async (input) => {
      requests.push(String(input));
      return script(String(input));
    };
    const made = await createServer({
      slug: 'redirect_test',
      name: 'redirect test',
      url: `${ORIGIN}/mcp`,
      transport: 'streamable_http',
      authMode: 'oauth',
      context: '',
      scopes: null,
      clientId: null,
      encryptedClientSecret: null,
      enabled: true,
    });
    if (!made.ok) throw new Error('server not created');
    const out = capture();
    await new McpPreparer(key.val, fetchImpl, publicOnly).prepare(
      { serverId: made.val.id, redirectUri: REDIRECT },
      out.response
    );
    return out.answer();
  }

  it('refuses a probe redirected to the cloud metadata address, without dialing it', async () => {
    const answer = await prepareAgainst(
      () => new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/x' } })
    );
    expect(answer.status).toBe(502);
    expect(answer.body).toContain('Refusing http://169.254.169.254/x');
    expect(requests).toEqual([`${ORIGIN}/mcp`]);
  });

  it('refuses a redirect of the probe POST that would turn it into a GET', async () => {
    const answer = await prepareAgainst(
      () => new Response(null, { status: 302, headers: { location: `${ORIGIN}/elsewhere` } })
    );
    expect(answer.status).toBe(502);
    expect(requests).toEqual([`${ORIGIN}/mcp`]);
  });
});
