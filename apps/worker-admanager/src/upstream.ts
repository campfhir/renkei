/**
 * The one HTTP client that dials an ADManager Plus server. Plain
 * node:http/https rather than fetch, for a reason: per-INSTANCE TLS
 * policy. ADManager Plus ships behind whatever certificate an IT
 * department set up (often self-signed or an internal CA), so an operator
 * may pin one for an instance or, as an explicit recorded decision, skip
 * verification for it — and global fetch offers neither per request
 * without pulling in undici as a dependency.
 *
 * Bodies are buffered up to a cap and never streamed: every ADManager
 * Plus answer Renkei wants is a small JSON document, and a runaway
 * response must fail loudly rather than fill the worker's memory.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';

export interface TlsPolicy {
  verify: boolean;
  /** An internal CA to trust instead of the system bundle. */
  caPem?: string | null;
}

export interface UpstreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  tls: TlsPolicy;
  timeoutMs: number;
  /** The most bytes of response body accepted; beyond it the call fails 'too_large'. */
  maxBodyBytes: number;
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type UpstreamFailure = { failed: 'timeout' | 'unreachable' | 'too_large'; detail: string };

export type UpstreamDialer = (
  input: UpstreamRequest
) => Promise<UpstreamResponse | UpstreamFailure>;

/** The production dialer; tests inject their own. */
export const dialUpstream: UpstreamDialer = (input) =>
  new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      resolve({ failed: 'unreachable', detail: 'the instance URL is not usable' });
      return;
    }
    const secure = url.protocol === 'https:';
    const options: RequestOptions = {
      method: input.method,
      headers: input.headers,
      timeout: input.timeoutMs,
      ...(secure
        ? {
            rejectUnauthorized: input.tls.verify,
            ...(input.tls.caPem ? { ca: input.tls.caPem } : {}),
          }
        : {}),
    };
    const make = secure ? httpsRequest : httpRequest;
    let settled = false;
    const settle = (value: UpstreamResponse | UpstreamFailure): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = make(url, options, (res) => {
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.byteLength;
        if (received > input.maxBodyBytes) {
          settle({
            failed: 'too_large',
            detail: `the response exceeds ${input.maxBodyBytes} bytes`,
          });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        settle({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', (error) => settle({ failed: 'unreachable', detail: error.message }));
    });
    req.on('timeout', () => {
      settle({ failed: 'timeout', detail: `no answer within ${input.timeoutMs}ms` });
      req.destroy();
    });
    req.on('error', (error) => settle({ failed: 'unreachable', detail: error.message }));
    if (input.body) req.write(input.body);
    req.end();
  });

export function headerOf(response: UpstreamResponse, name: string): string | null {
  const raw = response.headers[name.toLowerCase()];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return typeof raw === 'string' ? raw : null;
}
