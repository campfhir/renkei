/**
 * Which replica holds a notebook's kernel, for a sandbox run as several
 * replicas behind one address.
 *
 * A kernel is a process in one replica's memory (kernel-sessions.ts),
 * and nothing routes a caller to the same replica twice: Compose's DNS
 * hands each call to whichever replica it likes. So a replica that
 * starts a kernel writes down that it has it — one small file per
 * kernel under `<data>/kernels/`, on the volume every replica mounts —
 * and a replica asked about a kernel it does not have looks there and
 * passes the call to the one that does (`relay`), handing back its
 * answer as its own. The caller never knows which replica answered.
 *
 * A claim is made before the kernel is started, with an exclusive
 * create, so two replicas asked at once for a notebook's first cell
 * settle on one kernel: the second finds the first's claim and relays.
 * A claim whose replica no longer answers (it restarted, it was scaled
 * away) is dropped and the kernel started here, which the page hears
 * about the usual way. A relayed call is never relayed again: the
 * replica it reaches handles it, with a kernel or by starting one.
 *
 * The file holds the replica's address on the replicas' own network and
 * nothing else; a replica's address is its first non-loopback IPv4
 * unless SANDBOX_WORKER_ADVERTISE_URL says otherwise.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { isRecord } from '@renkei/guards';

/** The header a relayed call carries, so the replica it reaches does not relay it on. */
export const KERNEL_RELAYED_HEADER = 'x-renkei-kernel-relayed';

/** How long a replica has to answer its health check before its claims are taken for dead. */
const ALIVE_TIMEOUT_MS = 3_000;

export interface KernelHolder {
  /** One run of one replica: its claims are not a later run's. */
  instance: string;
  /** Where the other replicas reach it, e.g. `http://172.18.0.7:8092`. */
  address: string;
}

export interface RelayedAnswer {
  status: number;
  body: unknown;
}

/** This replica's address as its peers can reach it. */
export function advertisedAddress(port: number): string {
  const configured = process.env.SANDBOX_WORKER_ADVERTISE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal)
        return `http://${address.address}:${port}`;
    }
  }
  return `http://127.0.0.1:${port}`;
}

export class KernelRouting {
  constructor(
    private readonly directory: string,
    private readonly instance: string,
    /** Read when a claim is written: a server knows its port only once it listens. */
    private readonly address: () => string
  ) {}

  private file(key: string): string {
    return join(this.directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  }

  private self(): KernelHolder {
    return { instance: this.instance, address: this.address() };
  }

  isSelf(holder: KernelHolder): boolean {
    return holder.instance === this.instance;
  }

  /** Who has claimed the kernel, if anyone. */
  async holder(key: string): Promise<KernelHolder | null> {
    let raw: string;
    try {
      raw = await readFile(this.file(key), 'utf8');
    } catch {
      return null;
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (
        isRecord(value) &&
        typeof value.instance === 'string' &&
        typeof value.address === 'string'
      ) {
        return { instance: value.instance, address: value.address };
      }
    } catch {
      // A torn or foreign file is no claim.
    }
    return null;
  }

  /**
   * Claim the kernel for this replica. Null when it is ours now; the
   * holder when another replica claimed it first.
   */
  async claim(key: string): Promise<KernelHolder | null> {
    await mkdir(this.directory, { recursive: true });
    try {
      await writeFile(this.file(key), JSON.stringify(this.self()), { flag: 'wx' });
      return null;
    } catch {
      const holder = await this.holder(key);
      if (holder && !this.isSelf(holder)) return holder;
      // Ours already, or unreadable: write it plainly.
      await this.take(key);
      return null;
    }
  }

  /** Make the claim ours whoever held it: a relayed call reached us, or the holder is gone. */
  async take(key: string): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.file(key), JSON.stringify(this.self()));
  }

  /** Give up our claim (the kernel ended). Another replica's claim is left alone. */
  async release(key: string): Promise<void> {
    const holder = await this.holder(key);
    if (holder && this.isSelf(holder)) await this.drop(key);
  }

  /** Remove the claim, whoever's it is. */
  async drop(key: string): Promise<void> {
    await unlink(this.file(key)).catch(() => undefined);
  }

  /**
   * Pass a kernel call to the replica that holds the kernel and bring
   * back its answer; null when that replica does not answer at all.
   */
  async relay(
    holder: KernelHolder,
    op: string,
    body: unknown,
    authorization: string,
    timeoutMs: number
  ): Promise<RelayedAnswer | null> {
    try {
      const alive = await fetch(`${holder.address}/health`, {
        signal: AbortSignal.timeout(ALIVE_TIMEOUT_MS),
      });
      if (!alive.ok) return null;
    } catch {
      return null;
    }
    try {
      const response = await fetch(`${holder.address}/v1/workspaces/kernel/${op}`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
          [KERNEL_RELAYED_HEADER]: '1',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    } catch {
      return null;
    }
  }
}
