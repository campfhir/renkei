/**
 * The HTTP verbs for code project services and the organization's image
 * allow-list — dispatched from server.ts under `/v1/services/*`, the same
 * bearer-keyed JSON POST shape as every other sandbox operation.
 *
 *   services/start   { tenantId, subject, name, image, env?, exports? }
 *   services/list    { tenantId, subject }
 *   services/logs    { tenantId, subject, name, lines?, since?, match? }
 *   services/tail    { tenantId, subject, lines?, since?, match? }   every service, one stream
 *   services/stop    { tenantId, subject, name }
 *   services/rules/list     { tenantId }
 *   services/rules/set      { tenantId, id?, pattern, note?, registryUsername?, registrySecret?, clearCredential? }
 *   services/rules/delete   { tenantId, id }
 *   services/rules/restore  { tenantId }
 *
 * The service verbs are scoped by (tenantId, subject) like a checkout;
 * the rule verbs by tenant alone — they are the organization's, and the
 * web app lets only an operator reach them. A registry secret arrives in
 * a `set` body, is sealed here under this worker's key, and is never
 * returned: a listing carries the username only.
 */

import type { ServerResponse } from 'node:http';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  IMAGE_RULE_MAX_PER_TENANT,
  IMAGE_RULE_NOTE_MAX_CHARS,
  IMAGE_RULE_SECRET_MAX_CHARS,
  IMAGE_RULE_USERNAME_MAX_CHARS,
  SERVICE_LOGS_MAX_CHARS,
  SERVICE_TAIL_DEFAULT_LINES,
  clipOutput,
  compileLogMatch,
  renderLogEntries,
  sinceOf,
  normalizeImageRule,
  serviceLogLines,
  validateServiceEnv,
  validateServiceExports,
  validateServiceName,
  type ImageRuleSummary,
  type SandboxServiceSummary,
} from '@renkei/connector-sandbox';
import * as rules from './image-rules-store';
import { ServiceOpError, type ServiceManager } from './services';
import type { ServiceTarget } from './service-store';

export interface ServiceHandlerDeps {
  db: Kysely<DB>;
  /** The manager, when SANDBOX_SERVICES_ENABLED and the engine answered at boot; null answers every verb 503. */
  manager: ServiceManager | null;
}

type Body = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendError(response: ServerResponse, status: number, type: string, message?: string): void {
  sendJson(response, status, { error: { type, message } });
}

export function serviceWire(summary: SandboxServiceSummary) {
  return {
    id: summary.id,
    name: summary.name,
    image: summary.image,
    status: summary.status,
    error: summary.error,
    host: summary.host,
    ports: summary.ports,
    exportNames: summary.exportNames,
    createdAt: summary.createdAt.toISOString(),
    lastUsedAt: summary.lastUsedAt.toISOString(),
    expiresAt: summary.expiresAt.toISOString(),
  };
}

export function ruleWire(summary: ImageRuleSummary) {
  return {
    id: summary.id,
    pattern: summary.pattern,
    note: summary.note,
    registryUsername: summary.registryUsername,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
  };
}

const STATUS_OF: Record<ServiceOpError['type'], number> = {
  not_allowed: 403,
  not_found: 404,
  exists: 409,
  quota_exceeded: 429,
  engine: 502,
  bad_request: 400,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createServiceHandlers(deps: ServiceHandlerDeps) {
  const { db } = deps;

  function unavailable(response: ServerResponse): void {
    sendError(
      response,
      503,
      'services_unavailable',
      'Code project services are not enabled on this deployment.'
    );
  }

  async function guarded(response: ServerResponse, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (error instanceof ServiceOpError) {
        return sendError(response, STATUS_OF[error.type], error.type, error.message);
      }
      if (error instanceof rules.DuplicateRuleError) {
        return sendError(response, 409, 'exists', error.message);
      }
      throw error;
    }
  }

  async function handleRules(op: string, body: Body, response: ServerResponse): Promise<void> {
    const tenantId = str(body.tenantId);
    if (!tenantId) return sendError(response, 400, 'bad_request');
    switch (op) {
      case 'list':
        return sendJson(response, 200, {
          rules: (await rules.listImageRules(db, tenantId)).map(ruleWire),
        });
      case 'restore': {
        const added = await rules.restoreDefaultImageRules(db, tenantId);
        return sendJson(response, 200, {
          added,
          rules: (await rules.listImageRules(db, tenantId)).map(ruleWire),
        });
      }
      case 'delete': {
        const id = str(body.id);
        if (!UUID_PATTERN.test(id))
          return sendError(response, 400, 'bad_request', 'A rule id is required.');
        const deleted = await rules.deleteImageRule(db, tenantId, id);
        if (!deleted) return sendError(response, 404, 'not_found', 'No such rule.');
        return sendJson(response, 200, { deleted: true, id });
      }
      case 'set': {
        const normalized = normalizeImageRule(body.pattern);
        if (!normalized.ok) return sendError(response, 400, 'bad_request', normalized.message);
        const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
        if (note && note.length > IMAGE_RULE_NOTE_MAX_CHARS) {
          return sendError(
            response,
            400,
            'bad_request',
            `A note is at most ${IMAGE_RULE_NOTE_MAX_CHARS} characters.`
          );
        }
        const username =
          typeof body.registryUsername === 'string' ? body.registryUsername.trim() : '';
        const secret = typeof body.registrySecret === 'string' ? body.registrySecret : '';
        if ((username && !secret) || (!username && secret)) {
          return sendError(
            response,
            400,
            'bad_request',
            'A registry credential is a username and a secret together.'
          );
        }
        if (
          username.length > IMAGE_RULE_USERNAME_MAX_CHARS ||
          secret.length > IMAGE_RULE_SECRET_MAX_CHARS
        ) {
          return sendError(response, 400, 'bad_request', 'The registry credential is too long.');
        }
        let credential: { registryUsername: string; registrySealed: string } | null | undefined;
        if (username) {
          const key = rules.registrySecretsKey();
          if (!key) {
            return sendError(
              response,
              503,
              'secrets_unavailable',
              'This worker has no key to seal a registry credential (SANDBOX_ENV_SECRETS_KEY or TOKEN_ENCRYPTION_KEY).'
            );
          }
          credential = {
            registryUsername: username,
            registrySealed: rules.sealRegistrySecret(secret, key),
          };
        } else if (body.clearCredential === true) {
          credential = null;
        }
        const id = str(body.id);
        if (id) {
          if (!UUID_PATTERN.test(id))
            return sendError(response, 400, 'bad_request', 'A rule id is a uuid.');
          const updated = await rules.updateImageRule(db, {
            tenantId,
            id,
            pattern: normalized.rule.pattern,
            note,
            ...(credential !== undefined ? { credential } : {}),
          });
          if (!updated) return sendError(response, 404, 'not_found', 'No such rule.');
          return sendJson(response, 200, { rule: ruleWire(updated), dropped: normalized.dropped });
        }
        if ((await rules.countImageRules(db, tenantId)) >= IMAGE_RULE_MAX_PER_TENANT) {
          return sendError(
            response,
            429,
            'quota_exceeded',
            `An organization keeps at most ${IMAGE_RULE_MAX_PER_TENANT} rules.`
          );
        }
        const created = await rules.insertImageRule(db, {
          tenantId,
          pattern: normalized.rule.pattern,
          note,
          registryUsername: credential ? credential.registryUsername : null,
          registrySealed: credential ? credential.registrySealed : null,
        });
        return sendJson(response, 201, { rule: ruleWire(created), dropped: normalized.dropped });
      }
      default:
        return sendError(response, 404, 'unknown_operation');
    }
  }

  async function handleServices(op: string, body: Body, response: ServerResponse): Promise<void> {
    const manager = deps.manager;
    if (!manager) return unavailable(response);
    if (op.startsWith('rules/')) {
      return guarded(response, () => handleRules(op.slice('rules/'.length), body, response));
    }
    const tenantId = str(body.tenantId);
    const subject = str(body.subject);
    if (!tenantId || !subject) return sendError(response, 400, 'bad_request');
    const target: ServiceTarget = { tenantId, subject };
    return guarded(response, async () => {
      switch (op) {
        case 'list':
          return sendJson(response, 200, {
            services: (await manager.list(target)).map(serviceWire),
          });
        case 'start': {
          const name = validateServiceName(body.name);
          if (!name.ok) return sendError(response, 400, 'bad_request', name.message);
          const env = validateServiceEnv(body.env);
          if (!env.ok) return sendError(response, 400, 'bad_request', env.message);
          const exported = validateServiceExports(body.exports);
          if (!exported.ok) return sendError(response, 400, 'bad_request', exported.message);
          const started = await manager.start(target, {
            name: name.name,
            image: str(body.image),
            env: env.env,
            exports: exported.exports,
          });
          return sendJson(response, 201, { service: serviceWire(started) });
        }
        case 'stop': {
          const name = validateServiceName(body.name);
          if (!name.ok) return sendError(response, 400, 'bad_request', name.message);
          const stopped = await manager.stop(target, name.name);
          return sendJson(response, 200, { service: serviceWire(stopped) });
        }
        case 'logs': {
          const name = validateServiceName(body.name);
          if (!name.ok) return sendError(response, 400, 'bad_request', name.message);
          const since = sinceOf(body.since);
          if (!since.ok) return sendError(response, 400, 'bad_request', since.message);
          const match = compileLogMatch(body.match);
          if (!match.ok) return sendError(response, 400, 'bad_request', match.message);
          const { service, entries } = await manager.logs(target, name.name, {
            lines: serviceLogLines(body.lines),
            since: since.since,
            match: match.match,
          });
          const clipped = clipOutput(renderLogEntries(entries, false), SERVICE_LOGS_MAX_CHARS);
          return sendJson(response, 200, {
            service: serviceWire(service),
            logs: clipped.text,
            truncated: clipped.clipped,
            count: entries.length,
            lastAt: entries.length ? entries[entries.length - 1]!.at : null,
          });
        }
        case 'tail': {
          const since = sinceOf(body.since);
          if (!since.ok) return sendError(response, 400, 'bad_request', since.message);
          const match = compileLogMatch(body.match);
          if (!match.ok) return sendError(response, 400, 'bad_request', match.message);
          const tailed = await manager.tail(target, {
            lines:
              body.lines === undefined ? SERVICE_TAIL_DEFAULT_LINES : serviceLogLines(body.lines),
            since: since.since,
            match: match.match,
          });
          return sendJson(response, 200, tailed);
        }
        default:
          return sendError(response, 404, 'unknown_operation');
      }
    });
  }

  return { handleServices };
}
