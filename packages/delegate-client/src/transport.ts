/**
 * How every caller reaches the delegate (apps/worker-delegate): one POST
 * per op, the shared bearer key, a JSON body, and the delegate's error
 * envelope mapped to a typed verdict. The web app's Mirth, ADManager and
 * OnBase service clients have this same shape; the delegate's is kept as
 * a package because the workers call it too.
 *
 * Configuration: DELEGATE_WORKER_URL + DELEGATE_WORKER_API_KEY, both set
 * or both absent. Absent means every op answers `DELEGATE_UNCONFIGURED`:
 * with no delegate there is no key, and nothing opens.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Err, Result } from '@campfhir/safe-functions/types';

export interface DelegateConfig {
  url: string;
  apiKey: string;
}

/** The two verdicts that are about reaching the delegate rather than about the op. */
export type DelegateTransportError = 'DELEGATE_UNCONFIGURED' | 'DELEGATE_UNREACHABLE';

/**
 * An op's failure: the tag is the delegate's own error type, verbatim
 * (`KEY_LOCKED`, `NO_ACCESS`, …), or one of the transport verdicts; the
 * HTTP status rides in `cause` for the callers that map statuses.
 */
export type DelegateCallError = Err<string>;

const REQUEST_TIMEOUT_MS = 30_000;

export function delegateConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DelegateConfig | null {
  const url = env.DELEGATE_WORKER_URL?.trim();
  const apiKey = env.DELEGATE_WORKER_API_KEY?.trim();
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/+$/, ''), apiKey };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class DelegateTransport {
  constructor(
    private readonly config: DelegateConfig | null,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)
  ) {}

  get configured(): boolean {
    return this.config !== null;
  }

  /** One op; the parsed JSON body on 2xx, the delegate's error tag otherwise. */
  async call(
    op: string,
    body: Record<string, unknown>
  ): Promise<Result<Record<string, unknown>, string>> {
    if (!this.config) return err('DELEGATE_UNCONFIGURED');
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.url}/v1/${op}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      return err('DELEGATE_UNREACHABLE', { cause });
    }
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = isRecord(json) && isRecord(json.error) ? json.error : {};
      return err(typeof error.type === 'string' ? error.type : 'internal', {
        message: typeof error.message === 'string' ? error.message : undefined,
        cause: { status: response.status },
      });
    }
    if (!isRecord(json)) return err('DELEGATE_UNREACHABLE');
    return ok(json);
  }
}
