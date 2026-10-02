/**
 * The delegate's HTTP surface (docs/delegate-key-design.md): the bearer
 * key is the trust boundary, every op names a tenant and a subject the
 * caller has already authenticated, and what comes back is the least the
 * caller's request needs.
 *
 * Key ops (phase 1; the token proxy and the connector forwarders join
 * them in their own modules):
 *
 *   resource-key/ensure, open, open-many, create, share, revoke, delete,
 *   has, holders      — a chat's or project's data key, wrapped per holder.
 *                       `ensure`/`open`/`open-many` answer the key itself
 *                       (base64), for the caller's ContentCipher.
 *   user-sealed/seal, open
 *                     — values that belong to one person only (`uenc1:`),
 *                       opened and sealed here; the key never leaves.
 *   own-key/status, adopt, unlock, lock, revert
 *                     — a person's passphrase-derived key.
 *   user-key/rotate, shred
 *                     — the managed key's salt rotation and the shred.
 *   maintenance/prune-orphan-keys
 *                     — the sweep's orphan prune.
 *
 * Token ops (grants.ts): api (raw, streaming), oauth/exchange,
 * grant/commit, grant/describe, grant/revoke, grant/delete.
 * Connector workers (forward.ts): forward/<connector>/<op>.
 */

import type { Server, ServerResponse } from 'node:http';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  adoptOwnKey,
  createResourceKey,
  deleteResourceKey,
  ensureResourceKey,
  getUserKeyStatus,
  hasResourceKey,
  listResourceKeyHolders,
  lockOwnKey,
  openForSubject,
  openResourceKey,
  openResourceKeys,
  pruneOrphanResourceKeys,
  revertToManagedKey,
  revokeResourceKey,
  rotateUserKek,
  sealForSubject,
  shareResourceKey,
  shredUserKek,
  unlockOwnKey,
  type ResourceKey,
  type ResourceKeyKind,
  type ResourceRef,
  type UserKeyStatus,
} from '@renkei/user-keys';
import { createJsonRpcServer, sendJson, str } from '@renkei/worker-kit';
import { sendError } from './errors';
import { Grants, type DelegateLogger, silentDelegateLogger } from './grants';
import { Forwarder } from './forward';

export interface DelegateServerDeps {
  db: Kysely<DB>;
  /** TOKEN_ENCRYPTION_KEY: opens the org-wide connector configs a refresh needs. */
  encryptionKey: Buffer;
  /** Accepted bearer keys; empty means every request is refused. */
  apiKeys: string[];
  /** Injected in tests; production dials the provider. */
  fetchImpl?: typeof fetch;
  /** The worker's logger; silent when omitted (tests, in-process use). */
  logger?: DelegateLogger;
}

/** A batch of values to seal or open; a chat's whole memory list fits many times over. */
const MAX_JSON_BYTES = 8 * 1_048_576;

const KINDS: readonly ResourceKeyKind[] = ['chat', 'chat_project', 'prompt_library'];

function kindOf(value: unknown): ResourceKeyKind | null {
  return KINDS.find((kind) => kind === value) ?? null;
}

function refOf(body: Record<string, unknown>): ResourceRef | null {
  const tenantId = str(body.tenantId);
  const kind = kindOf(body.kind);
  const resourceId = str(body.resourceId);
  if (!tenantId || !kind || !resourceId) return null;
  return { tenantId, kind, resourceId };
}

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

function keyView(key: ResourceKey): { id: string; key: string } {
  return { id: key.id, key: key.key.toString('base64') };
}

function statusView(status: UserKeyStatus): Record<string, unknown> {
  return {
    mode: status.mode,
    version: status.version,
    locked: status.locked,
    unlockedUntil: status.unlockedUntil ? status.unlockedUntil.toISOString() : null,
    createdAt: status.createdAt ? status.createdAt.toISOString() : null,
    rotatedAt: status.rotatedAt ? status.rotatedAt.toISOString() : null,
  };
}

function unlockMsOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function createDelegateServer(deps: DelegateServerDeps): Server {
  const { db } = deps;
  const logger = deps.logger ?? silentDelegateLogger;
  const grants = new Grants(db, deps.encryptionKey, logger, deps.fetchImpl);
  const forwarder = new Forwarder(db, grants, deps.fetchImpl);

  type Handler = (body: Record<string, unknown>, response: ServerResponse) => Promise<void>;

  const handlers: Record<string, Handler> = {
    // ── resource keys ──────────────────────────────────────────────────────
    'resource-key/ensure': async (body, response) => {
      const ref = refOf(body);
      const ownerSubject = str(body.ownerSubject);
      if (!ref || !ownerSubject) return sendError(response, 'bad_request');
      const key = await ensureResourceKey(db, ref, ownerSubject);
      if (!key.ok) return sendError(response, key.err.type);
      sendJson(response, 200, keyView(key.val));
    },
    'resource-key/create': async (body, response) => {
      const ref = refOf(body);
      const ownerSubject = str(body.ownerSubject);
      if (!ref || !ownerSubject) return sendError(response, 'bad_request');
      const key = await createResourceKey(db, ref, ownerSubject);
      if (!key.ok) return sendError(response, key.err.type);
      sendJson(response, 200, keyView(key.val));
    },
    'resource-key/open': async (body, response) => {
      const ref = refOf(body);
      const subject = str(body.subject);
      if (!ref || !subject) return sendError(response, 'bad_request');
      const key = await openResourceKey(db, ref, subject);
      if (!key.ok) return sendError(response, key.err.type);
      sendJson(response, 200, keyView(key.val));
    },
    'resource-key/open-many': async (body, response) => {
      const tenantId = str(body.tenantId);
      const kind = kindOf(body.kind);
      if (!tenantId || !kind || !Array.isArray(body.entries)) {
        return sendError(response, 'bad_request');
      }
      const entries: { resourceId: string; subject: string }[] = [];
      for (const entry of body.entries) {
        if (typeof entry !== 'object' || entry === null) return sendError(response, 'bad_request');
        const record: Record<string, unknown> = Object.fromEntries(Object.entries(entry));
        const resourceId = str(record.resourceId);
        const subject = str(record.subject);
        if (!resourceId || !subject) return sendError(response, 'bad_request');
        entries.push({ resourceId, subject });
      }
      const opened = await openResourceKeys(db, tenantId, kind, entries);
      const keys: Record<string, { id: string; key: string }> = {};
      for (const [resourceId, key] of opened) keys[resourceId] = keyView(key);
      sendJson(response, 200, { keys });
    },
    'resource-key/share': async (body, response) => {
      const ref = refOf(body);
      const fromSubject = str(body.fromSubject);
      const toSubject = str(body.toSubject);
      if (!ref || !fromSubject || !toSubject) return sendError(response, 'bad_request');
      const shared = await shareResourceKey(db, ref, fromSubject, toSubject);
      if (!shared.ok) return sendError(response, shared.err.type);
      sendJson(response, 200, { ok: true });
    },
    'resource-key/revoke': async (body, response) => {
      const ref = refOf(body);
      const subject = str(body.subject);
      if (!ref || !subject) return sendError(response, 'bad_request');
      sendJson(response, 200, { revoked: await revokeResourceKey(db, ref, subject) });
    },
    'resource-key/delete': async (body, response) => {
      const ref = refOf(body);
      if (!ref) return sendError(response, 'bad_request');
      await deleteResourceKey(db, ref);
      sendJson(response, 200, { ok: true });
    },
    'resource-key/has': async (body, response) => {
      const ref = refOf(body);
      if (!ref) return sendError(response, 'bad_request');
      sendJson(response, 200, { exists: await hasResourceKey(db, ref) });
    },
    'resource-key/holders': async (body, response) => {
      const ref = refOf(body);
      if (!ref) return sendError(response, 'bad_request');
      sendJson(response, 200, { holders: await listResourceKeyHolders(db, ref) });
    },

    // ── person-only values ─────────────────────────────────────────────────
    'user-sealed/seal': async (body, response) => {
      const tenantId = str(body.tenantId);
      const subject = str(body.subject);
      const values = strings(body.values);
      if (!tenantId || !subject || !values) return sendError(response, 'bad_request');
      const sealed: string[] = [];
      for (const value of values) {
        const result = await sealForSubject(db, tenantId, subject, value);
        if (!result.ok) return sendError(response, result.err.type);
        sealed.push(result.val);
      }
      sendJson(response, 200, { sealed });
    },
    'user-sealed/open': async (body, response) => {
      const tenantId = str(body.tenantId);
      const subject = str(body.subject);
      const stored = strings(body.stored);
      if (!tenantId || !subject || !stored) return sendError(response, 'bad_request');
      // A value that will not open is null in its slot; a key that is
      // missing or locked fails the whole batch, since nothing would open.
      const opened: (string | null)[] = [];
      for (const value of stored) {
        const result = await openForSubject(db, tenantId, subject, value);
        if (result.ok) {
          opened.push(result.val);
        } else if (result.err.type === 'DECRYPTION_ERROR') {
          opened.push(null);
        } else {
          return sendError(response, result.err.type);
        }
      }
      sendJson(response, 200, { opened });
    },

    // ── a person's own key ─────────────────────────────────────────────────
    'own-key/status': async (body, response) => {
      const tenantId = str(body.tenantId);
      const subject = str(body.subject);
      if (!tenantId || !subject) return sendError(response, 'bad_request');
      sendJson(response, 200, statusView(await getUserKeyStatus(db, tenantId, subject)));
    },
    'own-key/adopt': async (body, response) => {
      const tenantId = str(body.tenantId);
      const subject = str(body.subject);
      const passphrase = str(body.passphrase);
      if (!tenantId || !subject || !passphrase) return sendError(response, 'bad_request');
      const adopted = await adoptOwnKey(db, tenantId, subject, passphrase, {
        unlockMs: unlockMsOf(body.unlockMs),
      });
      if (!adopted.ok) return sendError(response, adopted.err.type);
      sendJson(response, 200, statusView(adopted.val));
    },
    'own-key/unlock': async (body, response) => {
      const tenantId = str(body.tenantId);
      const subject = str(body.subject);
      const passphrase = str(body.passphrase);
      if (!tenantId || !subject || !passphrase) return sendError(response, 'bad_request');
      const unlocked = await unlockOwnKey(db, tenantId, subject, passphrase, {
        unlockMs: unlockMsOf(body.unlockMs),
      });
      if (!unlocked.ok) return sendError(response, unlocked.err.type);
      sendJson(response, 200, statusView(unlocked.val));
    },
    'own-key/lock': async (body, response) => {
      const tenantId = str(body.tenantId);
      const subject = str(body.subject);
      if (!tenantId || !subject) return sendError(response, 'bad_request');
      sendJson(response, 200, statusView(await lockOwnKey(db, tenantId, subject)));
    },
    'own-key/revert': async (body, response) => {
      const tenantId = str(body.tenantId);
      const subject = str(body.subject);
      const passphrase = str(body.passphrase);
      if (!tenantId || !subject || !passphrase) return sendError(response, 'bad_request');
      const reverted = await revertToManagedKey(db, tenantId, subject, passphrase);
      if (!reverted.ok) return sendError(response, reverted.err.type);
      sendJson(response, 200, statusView(reverted.val));
    },

    // ── the managed key itself ─────────────────────────────────────────────
    'user-key/rotate': async (body, response) => {
      const tenantId = str(body.tenantId);
      const subject = str(body.subject);
      if (!tenantId || !subject) return sendError(response, 'bad_request');
      const rotated = await rotateUserKek(db, tenantId, subject);
      if (!rotated.ok) return sendError(response, rotated.err.type);
      sendJson(response, 200, rotated.val);
    },
    'user-key/shred': async (body, response) => {
      const tenantId = str(body.tenantId);
      const subject = str(body.subject);
      if (!tenantId || !subject) return sendError(response, 'bad_request');
      sendJson(response, 200, { shredded: await shredUserKek(db, tenantId, subject) });
    },

    // ── maintenance ────────────────────────────────────────────────────────
    'maintenance/prune-orphan-keys': async (_body, response) => {
      sendJson(response, 200, { pruned: await pruneOrphanResourceKeys(db) });
    },

    // ── provider grants (tokens never leave this process; see grants.ts) ───
    'oauth/exchange': (body, response) => grants.exchange(body, response),
    'grant/commit': (body, response) => grants.commit(body, response),
    'grant/describe': (body, response) => grants.describeOp(body, response),
    'grant/revoke': (body, response) => grants.revoke(body, response),
    'grant/delete': (body, response) => grants.deleteOp(body, response),
  };

  return createJsonRpcServer({
    apiKeys: deps.apiKeys,
    maxBodyBytes: MAX_JSON_BYTES,
    handlers,
    // The proxy streams a raw body in and the provider's answer out.
    rawHandlers: { api: (request, response) => grants.api(request, response) },
    // forward/<connector>/<op>: the connector workers, with the person's
    // credential attached here (forward.ts).
    fallback: async (op, request, response) => {
      if (!(await forwarder.handle(op, request, response)))
        sendError(response, 'unknown_operation');
    },
    sendError,
    onUnhandledError: (error) => {
      logger.error('delegate op failed: {error}', {
        component: 'worker-delegate/server',
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}
