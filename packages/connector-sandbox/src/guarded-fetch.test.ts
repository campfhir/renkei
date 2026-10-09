/**
 * guardedFetch's contract, driven with a scripted resolver and transport
 * (no network): every redirect hop is re-guarded — a Location into the
 * metadata address, a private range, or an http:// downgrade is refused,
 * as is a chain longer than the ceiling — a public-to-public redirect is
 * followed, each hop is dialled at the address the resolver returned with
 * the original host kept for TLS and the Host header, the method semantics
 * of each redirect status hold, and credentials do not cross hosts.
 */

import net from 'node:net';
import { Readable } from 'node:stream';
import { BlockedUrlError } from './egress-guard';
import {
  GUARDED_FETCH_MAX_REDIRECTS,
  guardedFetch,
  type GuardedTransportRequest,
  type GuardedTransportResponse,
} from './guarded-fetch';

/** The names the tests know, and what they resolve to. */
const DNS: Record<string, string> = {
  'public.example': '93.184.216.34',
  'other.example': '198.51.100.7',
  'internal.example': '10.0.0.5',
};

async function resolve(hostname: string): Promise<string> {
  if (net.isIP(hostname)) return hostname;
  const address = DNS[hostname];
  if (!address) throw new BlockedUrlError(`could not resolve ${hostname}`);
  if (address.startsWith('10.')) {
    throw new BlockedUrlError('host resolves to a private or reserved address');
  }
  return address;
}

function reply(
  status: number,
  headers: Record<string, string> = {},
  body = ''
): GuardedTransportResponse {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Found',
    headers,
    body: Readable.from([Buffer.from(body)]),
  };
}

/** A transport answering each URL from a script and recording what it was asked to dial. */
function scripted(
  script: Record<string, GuardedTransportResponse | (() => GuardedTransportResponse)>
) {
  const dialled: GuardedTransportRequest[] = [];
  const transport = async (request: GuardedTransportRequest) => {
    dialled.push({ ...request, headers: { ...request.headers } });
    const entry = script[request.url.href];
    if (!entry) throw new Error(`unscripted ${request.url.href}`);
    return typeof entry === 'function' ? entry() : entry;
  };
  return { transport, dialled };
}

describe('guardedFetch redirects', () => {
  it('refuses a redirect to the cloud metadata address without dialling it', async () => {
    const { transport, dialled } = scripted({
      'https://public.example/start': reply(302, {
        location: 'https://169.254.169.254/latest/meta-data',
      }),
    });
    await expect(
      guardedFetch('https://public.example/start', {}, { resolve, transport })
    ).rejects.toThrow(/private or reserved/);
    expect(dialled).toHaveLength(1);
  });

  it('refuses a redirect to a name that resolves into 10.x', async () => {
    const { transport, dialled } = scripted({
      'https://public.example/start': reply(301, { location: 'https://internal.example/admin' }),
    });
    await expect(
      guardedFetch('https://public.example/start', {}, { resolve, transport })
    ).rejects.toThrow(/private or reserved/);
    expect(dialled.map((request) => request.url.hostname)).toEqual(['public.example']);
  });

  it('refuses a downgrade to http://', async () => {
    const { transport } = scripted({
      'https://public.example/start': reply(302, { location: 'http://public.example/plain' }),
    });
    await expect(
      guardedFetch('https://public.example/start', {}, { resolve, transport })
    ).rejects.toThrow(/only https/);
  });

  it('refuses a chain of more than five hops', async () => {
    const script: Record<string, GuardedTransportResponse> = {};
    for (let hop = 0; hop <= 6; hop += 1) {
      script[`https://public.example/hop${hop}`] = reply(302, {
        location: `https://public.example/hop${hop + 1}`,
      });
    }
    const { transport, dialled } = scripted(script);
    await expect(
      guardedFetch('https://public.example/hop0', {}, { resolve, transport })
    ).rejects.toThrow(/too many redirects/);
    expect(dialled).toHaveLength(GUARDED_FETCH_MAX_REDIRECTS + 1);
  });

  it('follows a chain of exactly five hops', async () => {
    const script: Record<string, GuardedTransportResponse> = {};
    for (let hop = 0; hop < 5; hop += 1) {
      script[`https://public.example/hop${hop}`] = reply(302, {
        location: `https://public.example/hop${hop + 1}`,
      });
    }
    script['https://public.example/hop5'] = reply(200, { 'content-type': 'text/plain' }, 'done');
    const { transport } = scripted(script);
    const response = await guardedFetch('https://public.example/hop0', {}, { resolve, transport });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('done');
  });

  it('follows a public-to-public redirect, dialling each hop at its own verified address', async () => {
    const { transport, dialled } = scripted({
      'https://public.example/report': reply(302, { location: 'https://other.example/q4.pdf' }),
      'https://other.example/q4.pdf': reply(200, { 'content-type': 'application/pdf' }, '%PDF'),
    });
    const response = await guardedFetch(
      'https://public.example/report',
      { headers: { Authorization: 'Bearer secret', Accept: 'application/pdf' } },
      { resolve, transport }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(await response.text()).toBe('%PDF');

    expect(dialled.map((request) => request.address)).toEqual(['93.184.216.34', '198.51.100.7']);
    // The Host header is the URL's own name, not the address dialled.
    expect(dialled.map((request) => request.headers.host)).toEqual([
      'public.example',
      'other.example',
    ]);
    // Credentials do not follow the request to another host; other headers do.
    expect(dialled[0].headers.authorization).toBe('Bearer secret');
    expect(dialled[1].headers.authorization).toBeUndefined();
    expect(dialled[1].headers.accept).toBe('application/pdf');
  });

  it('resolves a relative Location against the current URL', async () => {
    const { transport, dialled } = scripted({
      'https://public.example/a/start': reply(302, { location: '../final?x=1' }),
      'https://public.example/final?x=1': reply(200, {}, 'ok'),
    });
    const response = await guardedFetch(
      'https://public.example/a/start',
      {},
      { resolve, transport }
    );
    expect(response.status).toBe(200);
    expect(dialled[1].url.href).toBe('https://public.example/final?x=1');
  });

  it('turns a POST into a bodiless GET on 303 and 302, and keeps it on 307', async () => {
    const { transport, dialled } = scripted({
      'https://public.example/post303': reply(303, { location: 'https://public.example/after' }),
      'https://public.example/post302': reply(302, { location: 'https://public.example/after' }),
      'https://public.example/post307': reply(307, { location: 'https://public.example/after' }),
      'https://public.example/after': reply(200, {}, 'ok'),
    });
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code' }),
    };
    for (const path of ['post303', 'post302', 'post307']) {
      await guardedFetch(`https://public.example/${path}`, init, { resolve, transport });
    }
    const [first303, after303, first302, after302, first307, after307] = dialled;
    expect(first303.method).toBe('POST');
    expect(Buffer.from(first303.body!).toString()).toBe('grant_type=authorization_code');
    expect(first303.headers['content-length']).toBe('29');
    expect(after303.method).toBe('GET');
    expect(after303.body).toBeNull();
    expect(after303.headers['content-type']).toBeUndefined();
    expect(after303.headers['content-length']).toBeUndefined();
    expect(first302.method).toBe('POST');
    expect(after302.method).toBe('GET');
    expect(first307.method).toBe('POST');
    expect(after307.method).toBe('POST');
    expect(Buffer.from(after307.body!).toString()).toBe('grant_type=authorization_code');
    expect(after307.headers['content-type']).toBe('application/x-www-form-urlencoded');
  });
});

describe('guardedFetch first URL', () => {
  it('refuses the structural cases before resolving or dialling', async () => {
    const { transport, dialled } = scripted({});
    for (const url of [
      'http://public.example/',
      'https://localhost/',
      'https://169.254.169.254/latest',
      'not a url',
    ]) {
      await expect(guardedFetch(url, {}, { resolve, transport })).rejects.toThrow(BlockedUrlError);
    }
    expect(dialled).toHaveLength(0);
  });

  it('refuses a name that does not resolve rather than letting the request try', async () => {
    const { transport, dialled } = scripted({});
    await expect(
      guardedFetch('https://nowhere.example/', {}, { resolve, transport })
    ).rejects.toThrow(/could not resolve/);
    expect(dialled).toHaveLength(0);
  });

  it('refuses a name that resolves privately', async () => {
    const { transport, dialled } = scripted({});
    await expect(
      guardedFetch('https://internal.example/', {}, { resolve, transport })
    ).rejects.toThrow(/private or reserved/);
    expect(dialled).toHaveLength(0);
  });

  it('dials an IP-literal URL at that address with its own host header', async () => {
    const { transport, dialled } = scripted({
      'https://93.184.216.34:8443/x': reply(200, {}, 'ok'),
    });
    await guardedFetch('https://93.184.216.34:8443/x', {}, { resolve, transport });
    expect(dialled[0].address).toBe('93.184.216.34');
    expect(dialled[0].headers.host).toBe('93.184.216.34:8443');
  });

  it('answers a bodiless status without a body', async () => {
    const { transport } = scripted({ 'https://public.example/none': reply(204, {}, '') });
    const response = await guardedFetch('https://public.example/none', {}, { resolve, transport });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('fails with the signal’s reason when already aborted', async () => {
    const { transport, dialled } = scripted({});
    const controller = new AbortController();
    controller.abort();
    await expect(
      guardedFetch('https://public.example/', { signal: controller.signal }, { resolve, transport })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(dialled).toHaveLength(0);
  });
});
