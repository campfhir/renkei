/**
 * The Docker Engine API calls the Docker provider makes, over the
 * engine's unix socket or a TCP address: plain node:http, no dependency.
 * The engine is the ORCHESTRATOR's alone — a trusted process that runs
 * nobody's code — which is the point of the orchestrator: no sandbox,
 * and nothing a sandbox runs, holds a way to the engine any more.
 */

import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { isRecord } from '@renkei/guards';
import { ProviderError } from './provider';

export interface EngineResponse {
  status: number;
  body: Buffer;
}

export interface EngineTransport {
  call(
    method: string,
    path: string,
    input?: { body?: unknown; timeoutMs?: number }
  ): Promise<EngineResponse>;
}

/** How the engine is reached: `unix:///var/run/docker.sock` (the default) or `tcp://host:port`. */
export interface DockerAddress {
  socketPath?: string;
  host?: string;
  port?: number;
}

export function parseDockerHost(raw: string | undefined): DockerAddress {
  const value = (raw ?? '').trim() || 'unix:///var/run/docker.sock';
  if (value.startsWith('unix://')) return { socketPath: value.slice('unix://'.length) };
  if (value.startsWith('tcp://') || value.startsWith('http://')) {
    const url = new URL(value.replace(/^tcp:/, 'http:'));
    return { host: url.hostname, port: Number(url.port || '2375') };
  }
  if (value.startsWith('/')) return { socketPath: value };
  throw new Error(`not a usable Docker engine address: ${value}`);
}

/** JSON from the engine, or null when it is not JSON — never a throw. */
export function parseEngineJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8') || 'null');
  } catch {
    return null;
  }
}

/** The engine's own words for a failure. */
export function engineMessage(response: EngineResponse): string {
  const parsed = parseEngineJson(response.body);
  if (isRecord(parsed) && typeof parsed.message === 'string') return parsed.message;
  return response.body.toString('utf8').trim() || `HTTP ${response.status}`;
}

export function createEngineTransport(address: DockerAddress): EngineTransport {
  return {
    call(method, path, input = {}) {
      const payload =
        input.body === undefined ? null : Buffer.from(JSON.stringify(input.body), 'utf8');
      const options: RequestOptions = {
        method,
        path,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {},
        ...(address.socketPath
          ? { socketPath: address.socketPath }
          : { host: address.host, port: address.port }),
      };
      return new Promise((resolve, reject) => {
        const req = httpRequest(options, (response: IncomingMessage) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) })
          );
          response.on('error', reject);
        });
        req.setTimeout(input.timeoutMs ?? 30_000, () => {
          req.destroy(new ProviderError(`the engine did not answer ${method} ${path} in time`));
        });
        req.on('error', (error: Error) =>
          reject(
            error instanceof ProviderError
              ? error
              : new ProviderError(`engine unreachable: ${error.message}`)
          )
        );
        if (payload) req.write(payload);
        req.end();
      });
    },
  };
}
