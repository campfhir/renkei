/**
 * A git ticket reaches the repository it was issued for and no other:
 * the person's token is good for every repository they can see on the
 * host, and a workspace command holds the ticket for fifteen minutes.
 * Runs on the memory store behind a real local HTTP server with a stub
 * dialer; nothing leaves the process.
 */

import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GITHUB } from '@renkei/provider-grants';
import { isRecord, readBody } from '@renkei/worker-kit';
import { GitTickets, repoKey, type GitDialer } from './git';
import { Grants, silentDelegateLogger } from './grants';

describe('git tickets bound to a repository', () => {
  const dialed: string[] = [];
  const dial: GitDialer = async (target) => {
    dialed.push(target.toString());
    return { status: 200, headers: {}, body: Readable.from(['ok']) };
  };
  // Only `accessFor` is used by the ticket paths.
  class StubGrants extends Grants {
    override async accessFor(): ReturnType<Grants['accessFor']> {
      return { ok: true, token: 'gho_secret' };
    }
  }
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const tickets = new GitTickets(new StubGrants(Buffer.alloc(32), silentDelegateLogger), dial);
    server = createServer((request, response) => {
      if (request.url === '/issue') {
        void readBody(request, 4096).then((raw) => {
          const body: unknown = JSON.parse(raw?.toString('utf8') ?? '{}');
          return tickets.issue(isRecord(body) ? body : {}, response);
        });
      } else {
        void tickets.proxy(request, response);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    registerDataStore(createMemoryDataStore());
    dialed.length = 0;
  });
  afterEach(() => resetDataStore());

  async function issue(body: Record<string, unknown>) {
    const answer = await fetch(`${base}/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: GITHUB, subject: 'alice', ...body }),
    });
    const json: unknown = await answer.json();
    return { status: answer.status, ticket: isRecord(json) ? String(json.ticket ?? '') : '' };
  }

  async function request(ticket: string, path: string) {
    const answer = await fetch(`${base}/git/${ticket}/github.com${path}?service=git-upload-pack`);
    await answer.text();
    return answer.status;
  }

  it('refuses a ticket request that names no valid repository', async () => {
    expect((await issue({})).status).toBe(400);
    expect((await issue({ repo: '../etc' })).status).toBe(400);
    expect((await issue({ repo: 'acme' })).status).toBe(400);
  });

  it('relays its own repository, in any letter case, and no other', async () => {
    const issued = await issue({ repo: 'Acme/Demo' });
    expect(issued.status).toBe(200);

    expect(await request(issued.ticket, '/acme/demo.git/info/refs')).toBe(200);
    expect(dialed).toEqual(['https://github.com/acme/demo.git/info/refs?service=git-upload-pack']);
    expect(await request(issued.ticket, '/ACME/demo/info/refs')).toBe(200);

    const before = dialed.length;
    expect(await request(issued.ticket, '/acme/other.git/info/refs')).toBe(404);
    expect(await request(issued.ticket, '/elsewhere/demo.git/info/refs')).toBe(404);
    expect(dialed.length).toBe(before);
  });

  it('keys repositories without their .git suffix, case-insensitively', () => {
    expect(repoKey('Acme', 'Demo.git')).toBe('acme/demo');
  });
});
