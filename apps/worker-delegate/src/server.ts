/**
 * The delegate's HTTP surface (docs/delegate-key-design.md): the bearer
 * key is the trust boundary, every op names a tenant and a subject the
 * caller has already authenticated, and what comes back is the least the
 * caller's request needs.
 *
 * Key ops (the token proxy and the connector forwarders join them in
 * their own modules):
 *
 *   keys/instances    — the live delegate instances and their public keys:
 *                       what a browser seals a person's key to.
 *   keys/status       — a person's enrollment and what is delegated for
 *                       them, for the browser and the agents worker.
 *   keys/enroll       — first sign-in: the browser's keys recorded, the
 *                       person's earlier rows moved, delegations stored.
 *   keys/delegate     — a later sign-in or a re-seal: fresh delegations.
 *   keys/revoke-automation, keys/rotate, keys/shred, keys/census.
 *   resource-key/ensure, open, open-many, create, share, wrap-under,
 *   grant-automation, revoke, delete, has, holders
 *                     — a chat's or project's data key, wrapped per holder.
 *                       `ensure`/`open`/`open-many` answer the key itself
 *                       (base64), for the caller's ContentCipher.
 *   user-sealed/seal, open
 *                     — values that belong to one person only, opened and
 *                       sealed here under the key their scope names.
 *   maintenance/prune-orphan-keys
 *                     — the sweep's orphan prune.
 *
 * Token ops (grants.ts): api (raw, streaming), oauth/exchange,
 * grant/commit, grant/describe, grant/revoke, grant/delete.
 * Connector workers (forward.ts): forward/<connector>/<op>.
 * Git for code workspaces (git.ts): grant/git-ticket, and /git/<ticket>/….
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  createResourceKey,
  delegationStatus,
  deleteResourceKey,
  enroll,
  enrollmentCensus,
  ensureResourceKey,
  grantAutomationAccess,
  hasResourceKey,
  listResourceKeyHolders,
  liveInstances,
  openForSubject,
  openResourceKey,
  openResourceKeys,
  pruneOrphanResourceKeys,
  revokeAutomation,
  revokeResourceKey,
  rotateUserKey,
  sealForSubject,
  shareResourceKey,
  shredUserKey,
  storeDelegations,
  wrapResourceKeyUnder,
  type DelegationInput,
  type ResourceKey,
  type ResourceKeyKind,
  type ResourceRef,
  type SealedDelegation,
  type SealScope,
} from '@renkei/user-keys';
import {
  createJsonRpcServer,
  isRecord,
  sendJson,
  str,
  type CallContext,
  type JsonRpcHandler,
  type NamedApiKey,
} from '@renkei/worker-kit';
import { verifySession, withKeyRequestScope, type KeyRequestScope } from '@renkei/user-keys';
import { AccessLog, outcomeOf, PERSISTED_OPS } from './access-log';
import { callerMayRun } from './callers';
import { sendError } from './errors';
import { Grants, type DelegateLogger, silentDelegateLogger } from './grants';
import { Forwarder } from './forward';
import { GitTickets, type GitDialer } from './git';
import type { InstanceSigner } from './signing';

export interface DelegateServerDeps {
  db: Kysely<DB>;
  /** TOKEN_ENCRYPTION_KEY: opens the org-wide connector configs a refresh needs. */
  encryptionKey: Buffer;
  /**
   * Accepted bearer keys with the caller each names (callers.ts). A plain
   * string is the web app's key — the one-shared-key form from before.
   * Empty means every request is refused.
   */
  apiKeys: readonly (string | NamedApiKey)[];
  /** Injected in tests; production dials the provider. */
  fetchImpl?: typeof fetch;
  /** The worker's logger; silent when omitted (tests, in-process use). */
  logger?: DelegateLogger;
  /** Injected in tests; production dials the git host with node's own client. */
  gitDialer?: GitDialer;
  /**
   * The deployment's instance-list signer (signing.ts), loaded at boot;
   * absent or null, `keys/instances` goes unsigned and a browser asks the
   * person before sealing to an instance it has not seen.
   */
  signer?: Promise<InstanceSigner | null> | InstanceSigner | null;
}

/** A batch of values to seal or open; a chat's whole memory list fits many times over. */
const MAX_JSON_BYTES = 8 * 1_048_576;

const KINDS: readonly ResourceKeyKind[] = ['chat', 'chat_project', 'prompt_library'];

function kindOf(value: unknown): ResourceKeyKind | null {
  return KINDS.find((kind) => kind === value) ?? null;
}

function refOf(body: Record<string, unknown>): ResourceRef | null {
  const kind = kindOf(body.kind);
  const resourceId = str(body.resourceId);
  if (!kind || !resourceId) return null;
  return { kind, resourceId };
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

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function sealedDelegationsOf(value: unknown): SealedDelegation[] | null {
  if (!Array.isArray(value)) return null;
  const out: SealedDelegation[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const record: Record<string, unknown> = Object.fromEntries(Object.entries(item));
    const instanceId = str(record.instanceId);
    const sealedKey = str(record.sealedKey);
    if (!instanceId || !sealedKey) return null;
    out.push({ instanceId, sealedKey });
  }
  return out;
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The delegation half of an enroll/delegate/rotate body, or null when malformed. */
function delegationInputOf(body: Record<string, unknown>): DelegationInput | null {
  const subject = str(body.subject);
  const sessionId = str(body.sessionId);
  const session = sealedDelegationsOf(body.session ?? []);
  const automation = sealedDelegationsOf(body.automation ?? []);
  if (!subject || !sessionId || !session || !automation) return null;
  return {
    subject,
    sessionId,
    session,
    automation,
    automationUntil: dateOf(body.automationUntil),
    revokeSession: body.revokeSession === true,
  };
}

/** The subject an op is about, under whichever name its body uses. */
function subjectOf(body: Record<string, unknown>): string {
  return (
    str(body.subject) || str(body.ownerSubject) || str(body.fromSubject) || str(body.bySubject)
  );
}

/** An id the op is about, for the access record: a resource, an account, a provider. */
function targetOf(body: Record<string, unknown>): string | undefined {
  return str(body.resourceId) || str(body.accountId) || str(body.provider) || undefined;
}

export function createDelegateServer(deps: DelegateServerDeps): Server {
  const { db } = deps;
  const logger = deps.logger ?? silentDelegateLogger;
  const grants = new Grants(db, deps.encryptionKey, logger, deps.fetchImpl);
  const forwarder = new Forwarder(db, grants, deps.fetchImpl);
  const git = new GitTickets(db, grants, deps.gitDialer);
  const access = new AccessLog(db, logger);
  const apiKeys: NamedApiKey[] = deps.apiKeys.map((entry) =>
    typeof entry === 'string' ? { name: 'web', key: entry } : entry
  );

  type Handler = (body: Record<string, unknown>, response: ServerResponse) => Promise<void>;

  /** Whether the run named belongs to the person the op is about: the agents worker's binding. */
  async function runBelongsTo(runId: string, subject: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return false;
    const row = await db
      .selectFrom('agent_runs')
      .select('id')
      .where('id', '=', runId)
      .where('owner_subject', '=', subject)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Every op runs through here (callers.ts, request-scope.ts): the caller
   * is known from its key; a request naming a session is bound to it after
   * the session is checked against the tenant and subject; the agents
   * worker names the run it acts for; a worker never opens a session ring;
   * and every op leaves an access line, the sensitive ones a row.
   */
  function guarded(op: string, handler: Handler): JsonRpcHandler {
    return async (body, response, context) => {
      const subject = subjectOf(body);
      const sessionId = str(body.sessionId);
      const scope: KeyRequestScope = {
        caller: context.caller,
        allowSession: context.caller === 'web',
        sessionId: null,
      };
      const finish = async (): Promise<void> => {
        const status = response.headersSent ? response.statusCode : 500;
        await access.record({
          caller: context.caller,
          op,
          subject,
          target: targetOf(body),
          outcome: outcomeOf(status),
          status,
          persist:
            PERSISTED_OPS.has(op) ||
            (op === 'keys/delegate' &&
              Array.isArray(body.automation) &&
              body.automation.length > 0),
        });
      };
      if (context.caller === 'agents' && subject) {
        const runId = str(body.runId);
        if (!runId || !(await runBelongsTo(runId, subject))) {
          sendError(response, 'RUN_MISMATCH', "the run named is not this person's");
          return finish();
        }
      }
      if (sessionId) {
        if (!subject || !(await verifySession(db, subject, sessionId))) {
          sendError(response, 'SESSION_MISMATCH', "the session named is not this person's");
          return finish();
        }
        scope.sessionId = sessionId;
      }
      try {
        await withKeyRequestScope(scope, () => handler(body, response));
      } finally {
        await finish();
      }
    };
  }

  const handlers: Record<string, Handler> = {
    // ── the person's keys ──────────────────────────────────────────────────
    'keys/instances': async (_body, response) => {
      const instances = await liveInstances(db);
      const signer = (await deps.signer) ?? null;
      sendJson(response, 200, {
        instances,
        signingKey: signer?.publicKey ?? null,
        signature: signer ? signer.sign(instances) : null,
      });
    },
    'keys/status': async (body, response) => {
      const subject = str(body.subject);
      if (!subject) return sendError(response, 'bad_request');
      const status = await delegationStatus(
        db,
        subject,
        str(body.sessionId) || undefined
      );
      sendJson(response, 200, {
        ...status,
        enrolledAt: iso(status.enrolledAt),
        automationUntil: iso(status.automationUntil),
      });
    },
    'keys/enroll': async (body, response) => {
      const delegation = delegationInputOf(body);
      const publicKey = str(body.publicKey);
      const wrappedPrivateKey = str(body.wrappedPrivateKey);
      const wrappedAutomationKey = str(body.wrappedAutomationKey);
      if (!delegation || !publicKey || !wrappedPrivateKey || !wrappedAutomationKey) {
        return sendError(response, 'bad_request');
      }
      const enrolled = await enroll(db, {
        ...delegation,
        publicKey,
        wrappedPrivateKey,
        wrappedAutomationKey,
        passphrase: str(body.passphrase) || undefined,
      });
      if (!enrolled.ok) return sendError(response, enrolled.err.type);
      sendJson(response, 200, {
        version: enrolled.val.version,
        enrolledAt: iso(enrolled.val.enrolledAt),
        migrated: enrolled.val.migrated,
      });
    },
    'keys/delegate': async (body, response) => {
      const delegation = delegationInputOf(body);
      if (!delegation) return sendError(response, 'bad_request');
      const stored = await storeDelegations(db, delegation);
      if (!stored.ok) return sendError(response, stored.err.type);
      sendJson(response, 200, { ok: true });
    },
    'keys/revoke-automation': async (body, response) => {
      const subject = str(body.subject);
      if (!subject) return sendError(response, 'bad_request');
      sendJson(response, 200, { revoked: await revokeAutomation(db, subject) });
    },
    'keys/rotate': async (body, response) => {
      const delegation = delegationInputOf(body);
      const wrappedPrivateKey = str(body.wrappedPrivateKey);
      const wrappedAutomationKey = str(body.wrappedAutomationKey);
      if (!delegation || !wrappedPrivateKey || !wrappedAutomationKey) {
        return sendError(response, 'bad_request');
      }
      const rotated = await rotateUserKey(db, {
        ...delegation,
        wrappedPrivateKey,
        wrappedAutomationKey,
      });
      if (!rotated.ok) return sendError(response, rotated.err.type);
      sendJson(response, 200, rotated.val);
    },
    'keys/shred': async (body, response) => {
      const subject = str(body.subject);
      if (!subject) return sendError(response, 'bad_request');
      sendJson(response, 200, { shredded: await shredUserKey(db, subject) });
    },
    'keys/census': async (body, response) => {
      sendJson(response, 200, await enrollmentCensus(db));
    },

    // ── resource keys ──────────────────────────────────────────────────────
    'resource-key/ensure': async (body, response) => {
      const ref = refOf(body);
      const ownerSubject = str(body.ownerSubject);
      if (!ref || !ownerSubject) return sendError(response, 'bad_request');
      const key = await ensureResourceKey(db, ref, ownerSubject, {
        automation: body.automation === true,
      });
      if (!key.ok) return sendError(response, key.err.type);
      sendJson(response, 200, keyView(key.val));
    },
    'resource-key/create': async (body, response) => {
      const ref = refOf(body);
      const ownerSubject = str(body.ownerSubject);
      if (!ref || !ownerSubject) return sendError(response, 'bad_request');
      const key = await createResourceKey(db, ref, ownerSubject, {
        automation: body.automation === true,
      });
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
      const kind = kindOf(body.kind);
      if (!kind || !Array.isArray(body.entries)) {
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
      const opened = await openResourceKeys(db, kind, entries);
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
    'resource-key/wrap-under': async (body, response) => {
      const ref = refOf(body);
      const bySubject = str(body.bySubject);
      const parentKind = kindOf(body.parentKind);
      const parentId = str(body.parentResourceId);
      if (!ref || !bySubject || !parentKind || !parentId) return sendError(response, 'bad_request');
      const wrapped = await wrapResourceKeyUnder(db, ref, bySubject, {
        kind: parentKind,
        resourceId: parentId,
      });
      if (!wrapped.ok) return sendError(response, wrapped.err.type);
      sendJson(response, 200, { ok: true });
    },
    'resource-key/grant-automation': async (body, response) => {
      const ref = refOf(body);
      const subject = str(body.subject);
      if (!ref || !subject) return sendError(response, 'bad_request');
      const granted = await grantAutomationAccess(db, ref, subject);
      if (!granted.ok) return sendError(response, granted.err.type);
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
      const subject = str(body.subject);
      const values = strings(body.values);
      const scope: SealScope = body.scope === 'session' ? 'session' : 'automation';
      if (!subject || !values) return sendError(response, 'bad_request');
      const sealed: string[] = [];
      for (const value of values) {
        const result = await sealForSubject(db, subject, value, scope);
        if (!result.ok) return sendError(response, result.err.type);
        sealed.push(result.val);
      }
      sendJson(response, 200, { sealed });
    },
    'user-sealed/open': async (body, response) => {
      const subject = str(body.subject);
      const stored = strings(body.stored);
      if (!subject || !stored) return sendError(response, 'bad_request');
      // A value that will not open is null in its slot; a key that is
      // missing or not delegated fails the whole batch, since nothing would open.
      const opened: (string | null)[] = [];
      for (const value of stored) {
        const result = await openForSubject(db, subject, value);
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
    'grant/git-ticket': (body, response) => git.issue(body, response),
  };

  const scopeFor = (context: CallContext): KeyRequestScope => ({
    caller: context.caller,
    allowSession: context.caller === 'web',
    sessionId: null,
  });

  /** The proxy's grant header, for the access record: tenant, subject, provider — never the body. */
  function grantHeaderOf(request: IncomingMessage): {
    subject: string;
    provider: string;
  } {
    const raw = request.headers['x-delegate-grant'];
    try {
      const parsed: unknown = JSON.parse(Array.isArray(raw) ? raw[0] : (raw ?? ''));
      if (!isRecord(parsed)) return { subject: '', provider: '' };
      return {
        subject: str(parsed.subject) || str(parsed.accountId),
        provider: str(parsed.provider),
      };
    } catch {
      return { subject: '', provider: '' };
    }
  }

  return createJsonRpcServer({
    apiKeys,
    allowOp: callerMayRun,
    onForbidden: (caller, op) => {
      void access.record({
        caller,
        op,
        subject: '',
        outcome: 'refused',
        status: 403,
        persist: PERSISTED_OPS.has(op),
      });
    },
    maxBodyBytes: MAX_JSON_BYTES,
    handlers: Object.fromEntries(
      Object.entries(handlers).map(([op, handler]) => [op, guarded(op, handler)])
    ),
    // The proxy streams a raw body in and the provider's answer out.
    rawHandlers: {
      api: async (request, response, context) => {
        const grant = grantHeaderOf(request);
        const method = str(request.headers['x-delegate-method']).toUpperCase() || 'GET';
        try {
          await withKeyRequestScope(scopeFor(context), () => grants.api(request, response));
        } finally {
          const status = response.headersSent ? response.statusCode : 500;
          await access.record({
            caller: context.caller,
            op: `api ${method}`,
            subject: grant.subject,
            target: grant.provider || undefined,
            outcome: outcomeOf(status),
            status,
            persist: method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS',
          });
        }
      },
    },
    // Git over HTTPS for code workspaces: the ticket in the path is the
    // credential, so these routes sit outside the bearer check (git.ts).
    openPrefixes: [
      { prefix: '/git/', handler: (request, response) => git.proxy(request, response) },
    ],
    // forward/<connector>/<op>: the connector workers, with the person's
    // credential attached here (forward.ts).
    fallback: async (op, request, response, context) => {
      const handled = await withKeyRequestScope(scopeFor(context), () =>
        forwarder.handle(op, request, response)
      );
      if (!handled) sendError(response, 'unknown_operation');
      const status = response.headersSent ? response.statusCode : 500;
      await access.record({
        caller: context.caller,
        op,
        subject: '',
        outcome: outcomeOf(status),
        status,
        persist: false,
      });
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
