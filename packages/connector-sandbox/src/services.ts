/**
 * Code project services — a container (Postgres, Redis, a message
 * broker) started beside a project's checkout so its tests have the
 * thing they need, from an image the organization allows. The pure half:
 * how an image reference is read, how an organization's allow-list is
 * written and matched, what a service may be called and handed, and how
 * a running service is announced to the project's commands. The Docker
 * engine, the rows and the HTTP verbs are apps/worker-sandbox's
 * (src/services.ts, src/service-endpoints.ts); the tools and the admin
 * page are apps/web's; both go through exactly this code so an image is
 * refused the same way everywhere.
 *
 * The allow-list is a set of RULES, one of three shapes, each a
 * normalized `host[/path]`:
 *
 *   myorg.azurecr.io              a whole registry — everything on it
 *   myorg.azurecr.io/platform/*   a namespace on one — everything under it
 *   docker.io/library/postgres    one repository — any tag or digest
 *
 * so an organization can allow its own private registry wholesale and
 * Docker Hub only for the handful of public images it names. A rule may
 * carry a registry credential (a service principal, a pull token); the
 * most specific matching rule wins, and its host's credential rides the
 * pull — the worker seals that value, this package never sees it.
 */

import { ENV_NAME_PATTERN, validateEnvName } from './workspaces';

// ─── Bounds ─────────────────────────────────────────────────────────────────

/** Services one project may run at once. */
export const SERVICE_MAX_PER_SUBJECT = 5;
/** A service's lifetime since its last use (a command in the project); the worker's sweep stops it after. */
export const SERVICE_TTL_MS = 24 * 60 * 60_000; // 24 hours
/** How long a pull and start may take before the verb gives up on it. */
export const SERVICE_START_TIMEOUT_MS = 5 * 60_000;
export const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** Variables handed to the container itself (POSTGRES_PASSWORD, ...). */
export const SERVICE_ENV_MAX = 32;
export const SERVICE_ENV_VALUE_MAX_CHARS = 4_096;
/** Variables the service exports into the project's commands (DATABASE_URL, ...). */
export const SERVICE_EXPORT_MAX = 16;
export const SERVICE_EXPORT_MAX_CHARS = 2_048;
export const SERVICE_LOGS_DEFAULT_CHARS = 8_000;
export const SERVICE_LOGS_MAX_CHARS = 40_000;
export const SERVICE_LOGS_DEFAULT_LINES = 200;
export const SERVICE_LOGS_MAX_LINES = 2_000;
/** Rules one organization may keep. */
export const IMAGE_RULE_MAX_PER_TENANT = 100;
export const IMAGE_RULE_NOTE_MAX_CHARS = 300;
export const IMAGE_RULE_USERNAME_MAX_CHARS = 255;
export const IMAGE_RULE_SECRET_MAX_CHARS = 4_096;
export const IMAGE_REFERENCE_MAX_CHARS = 512;

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export type ServiceStatus = 'starting' | 'running' | 'stopped' | 'failed' | 'gone';

export interface SandboxServiceSummary {
  id: string;
  name: string;
  /** The canonical reference the container was created from, tag or digest included. */
  image: string;
  status: ServiceStatus;
  error: string | null;
  /** Where the project's commands reach it while running; null otherwise. */
  host: string | null;
  /** The ports the image declares it listens on, in ascending order. */
  ports: number[];
  /** Names the service exports into the project's commands — never the templates' rendered values. */
  exportNames: string[];
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

export interface ImageRuleSummary {
  id: string;
  pattern: string;
  note: string | null;
  /** The username of the registry credential the rule carries, when it carries one. */
  registryUsername: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What every organization is allowed before an operator touches the list. */
export const DEFAULT_IMAGE_RULES: ReadonlyArray<{ pattern: string; note: string }> = [
  { pattern: 'docker.io/library/postgres', note: 'PostgreSQL (official image)' },
  { pattern: 'docker.io/pgvector/pgvector', note: 'PostgreSQL with the vector extension' },
  { pattern: 'docker.io/library/redis', note: 'Redis (official image)' },
  { pattern: 'docker.io/valkey/valkey', note: 'Valkey, the Redis fork' },
  { pattern: 'docker.io/library/mysql', note: 'MySQL (official image)' },
  { pattern: 'docker.io/library/mariadb', note: 'MariaDB (official image)' },
  { pattern: 'docker.io/library/mongo', note: 'MongoDB (official image)' },
  { pattern: 'docker.io/library/rabbitmq', note: 'RabbitMQ (official image)' },
  { pattern: 'mcr.microsoft.com/mssql/server', note: 'SQL Server on Linux' },
  {
    pattern: 'mcr.microsoft.com/azure-storage/azurite',
    note: 'Azurite, the Azure Storage emulator',
  },
];

// ─── Image references ───────────────────────────────────────────────────────

/** The names Docker Hub goes by; every one reads as `docker.io`. */
const DOCKER_HUB_HOSTS = new Set([
  'docker.io',
  'index.docker.io',
  'registry-1.docker.io',
  'hub.docker.com',
]);
const HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface ImageReference {
  /** The registry, lower-cased, Docker Hub's aliases folded to `docker.io`. */
  host: string;
  /** The repository under it — `library/postgres` for an official Docker Hub image. */
  path: string;
  tag: string | null;
  digest: string | null;
  /** `host/path:tag` or `host/path@digest`, the one spelling every row and label uses. */
  canonical: string;
}

/**
 * Whether the first segment of a reference names a registry: Docker's own
 * rule — it does if it has a dot or a colon, or is `localhost`; otherwise
 * it is the first path component of a Docker Hub repository.
 */
function looksLikeHost(segment: string): boolean {
  return segment.includes('.') || segment.includes(':') || segment === 'localhost';
}

function hostOf(raw: string): string | null {
  const host = raw.toLowerCase();
  if (!HOST_PATTERN.test(host)) return null;
  return DOCKER_HUB_HOSTS.has(host) ? 'docker.io' : host;
}

/**
 * Read an image reference the way `docker pull` would — `postgres:16`,
 * `pgvector/pgvector:pg16`, `myorg.azurecr.io/team/api@sha256:…` — into
 * its host, repository and tag or digest. A bare name gets `latest`; a
 * single-component Docker Hub name gets `library/`. Anything Docker would
 * not accept is refused with why.
 */
export function parseImageReference(
  input: unknown
): { ok: true; image: ImageReference } | { ok: false; message: string } {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { ok: false, message: 'An image reference is required.' };
  if (raw.length > IMAGE_REFERENCE_MAX_CHARS) {
    return {
      ok: false,
      message: `An image reference is at most ${IMAGE_REFERENCE_MAX_CHARS} characters.`,
    };
  }
  if (/\s/.test(raw)) return { ok: false, message: 'An image reference has no spaces.' };

  let rest = raw;
  let digest: string | null = null;
  let tag: string | null = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST_PATTERN.test(digest)) {
      return { ok: false, message: 'A digest is `sha256:` followed by 64 hex characters.' };
    }
  }
  // A colon after the last slash is a tag; one before it belongs to the host's port.
  const lastSlash = rest.lastIndexOf('/');
  const colon = rest.lastIndexOf(':');
  if (colon > lastSlash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG_PATTERN.test(tag)) {
      return {
        ok: false,
        message: 'A tag is letters, digits, dots, dashes and underscores (at most 128 characters).',
      };
    }
  }
  if (!rest) return { ok: false, message: 'An image reference names a repository.' };

  const segments = rest.split('/');
  let host = 'docker.io';
  if (segments.length > 1 && looksLikeHost(segments[0]!)) {
    const parsed = hostOf(segments.shift()!);
    if (!parsed) return { ok: false, message: 'The registry host is not a usable hostname.' };
    host = parsed;
  }
  if (segments.some((segment) => !segment)) {
    return { ok: false, message: 'An image reference has no empty path components.' };
  }
  const lowered = segments.map((segment) => segment.toLowerCase());
  if (segments.some((segment, index) => segment !== lowered[index])) {
    return { ok: false, message: 'A repository path is lower-case.' };
  }
  if (lowered.some((segment) => !PATH_COMPONENT.test(segment))) {
    return {
      ok: false,
      message:
        'A repository path is lower-case letters, digits and single dots, dashes or underscores between them.',
    };
  }
  if (host === 'docker.io' && lowered.length === 1) lowered.unshift('library');
  const path = lowered.join('/');
  if (!tag && !digest) tag = 'latest';
  const canonical = digest ? `${host}/${path}@${digest}` : `${host}/${path}:${tag}`;
  return { ok: true, image: { host, path, tag, digest, canonical } };
}

// ─── Rules ──────────────────────────────────────────────────────────────────

export interface ImageRule {
  host: string;
  /** Empty for a whole registry; `team/*` for a namespace; `library/postgres` for one repository. */
  path: string;
  /** The normalized `host[/path]` spelling. */
  pattern: string;
}

/**
 * Read a rule as an operator types it — `myorg.azurecr.io`,
 * `myorg.azurecr.io/platform/*`, `postgres`, `docker.io/library/redis`,
 * `pgvector/pgvector:pg16` — into its normalized form. A tag or digest on
 * a rule is dropped with a note: rules are about WHERE an image comes
 * from, not which build of it. A bare single name is a Docker Hub
 * official image, exactly as `docker pull` would read it.
 */
export function normalizeImageRule(
  input: unknown
): { ok: true; rule: ImageRule; dropped: string | null } | { ok: false; message: string } {
  const raw = typeof input === 'string' ? input.trim().replace(/\/+$/, '') : '';
  if (!raw) return { ok: false, message: 'A rule is required.' };
  if (raw.length > IMAGE_REFERENCE_MAX_CHARS) {
    return { ok: false, message: `A rule is at most ${IMAGE_REFERENCE_MAX_CHARS} characters.` };
  }
  if (/\s/.test(raw)) return { ok: false, message: 'A rule has no spaces.' };
  if (raw.includes('*') && !raw.endsWith('/*')) {
    return {
      ok: false,
      message: 'A wildcard is only `/*` at the end of a rule, for everything under a namespace.',
    };
  }
  const wildcard = raw.endsWith('/*');
  const body = wildcard ? raw.slice(0, -2) : raw;
  // A whole registry: one segment that reads as a host — a dotted name,
  // or localhost with or without a port. `postgres:16` has a colon too,
  // but with no dot it is an image and its tag, exactly as `docker pull`
  // reads it.
  if (!body.includes('/') && (body.includes('.') || /^localhost(:\d+)?$/.test(body))) {
    if (wildcard) {
      return {
        ok: false,
        message: 'A whole registry is just its host; `/*` belongs after a namespace.',
      };
    }
    const host = hostOf(body);
    if (!host) return { ok: false, message: 'The registry host is not a usable hostname.' };
    return { ok: true, rule: { host, path: '', pattern: host }, dropped: null };
  }
  if (wildcard) {
    // A namespace: `host/ns/*`, or `ns/*` on Docker Hub. Read by hand
    // rather than as a reference, because a one-component Docker Hub
    // path is a NAMESPACE here (`pgvector/*`), not the official image
    // `library/pgvector` a reference would make of it.
    if (body.includes(':') && !/^[^/]+:\d+\//.test(body)) {
      return { ok: false, message: 'A namespace rule carries no tag.' };
    }
    if (body.includes('@')) return { ok: false, message: 'A namespace rule carries no digest.' };
    const segments = body.split('/');
    let host = 'docker.io';
    if (segments.length > 1 && looksLikeHost(segments[0]!)) {
      const parsed = hostOf(segments.shift()!);
      if (!parsed) return { ok: false, message: 'The registry host is not a usable hostname.' };
      host = parsed;
    }
    if (segments.length === 0 || segments.some((segment) => !PATH_COMPONENT.test(segment))) {
      return {
        ok: false,
        message:
          'A namespace is lower-case letters, digits and single dots, dashes or underscores between them.',
      };
    }
    const path = `${segments.join('/')}/*`;
    return { ok: true, rule: { host, path, pattern: `${host}/${path}` }, dropped: null };
  }
  const hasDigest = body.includes('@');
  const hasTag = !hasDigest && body.slice(body.lastIndexOf('/') + 1).includes(':');
  const parsed = parseImageReference(body);
  if (!parsed.ok) return parsed;
  const { image } = parsed;
  const dropped = hasDigest ? 'the digest' : hasTag ? `the tag ${image.tag}` : null;
  return {
    ok: true,
    rule: { host: image.host, path: image.path, pattern: `${image.host}/${image.path}` },
    dropped,
  };
}

/** Whether one rule allows one image. */
export function imageRuleMatches(rule: ImageRule, image: ImageReference): boolean {
  if (rule.host !== image.host) return false;
  if (rule.path === '') return true;
  if (rule.path.endsWith('/*')) {
    const prefix = rule.path.slice(0, -1); // keeps the trailing slash
    return image.path.startsWith(prefix);
  }
  return rule.path === image.path;
}

/** How specific a rule is: a repository beats a namespace beats a registry; a longer namespace beats a shorter. */
function ruleSpecificity(rule: ImageRule): number {
  if (rule.path === '') return 0;
  if (rule.path.endsWith('/*')) return 1 + rule.path.length / 1_000;
  return 2;
}

/**
 * The rule that allows an image, the most specific of those that do —
 * null when none does. Given the rows with their normalized patterns
 * (`pattern` is what is stored), so the caller can read the credential
 * off the winning row.
 */
export function matchImageRule<T extends { pattern: string }>(
  rules: T[],
  image: ImageReference
): T | null {
  let best: { row: T; rank: number } | null = null;
  for (const row of rules) {
    const normalized = normalizeImageRule(row.pattern);
    if (!normalized.ok) continue;
    if (!imageRuleMatches(normalized.rule, image)) continue;
    const rank = ruleSpecificity(normalized.rule);
    if (!best || rank > best.rank) best = { row, rank };
  }
  return best?.row ?? null;
}

/** The host a rule speaks for, for picking a credential for a pull. */
export function imageRuleHost(pattern: string): string | null {
  const normalized = normalizeImageRule(pattern);
  return normalized.ok ? normalized.rule.host : null;
}

// ─── What a service is called and handed ────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateServiceName(
  input: unknown
): { ok: true; name: string } | { ok: false; message: string } {
  const name = typeof input === 'string' ? input.trim() : '';
  if (!SERVICE_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      message:
        'A service name is lower-case letters, digits and dashes, starting with a letter (at most 32 characters) — `db`, `redis`, `queue`.',
    };
  }
  return { ok: true, name };
}

/** The container's own environment — what the image reads to configure itself. */
export function validateServiceEnv(
  input: unknown
): { ok: true; env: Record<string, string> } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, env: {} };
  if (!isRecord(input)) {
    return { ok: false, message: 'env is an object of variable names to values.' };
  }
  const entries = Object.entries(input);
  if (entries.length > SERVICE_ENV_MAX) {
    return { ok: false, message: `A service takes at most ${SERVICE_ENV_MAX} variables.` };
  }
  const env: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!ENV_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        message: `${name} is not a usable variable name (upper-case letters, digits, underscores).`,
      };
    }
    if (typeof value !== 'string') return { ok: false, message: `${name}: a value is a string.` };
    if (value.length > SERVICE_ENV_VALUE_MAX_CHARS) {
      return {
        ok: false,
        message: `${name}: a value is at most ${SERVICE_ENV_VALUE_MAX_CHARS} characters.`,
      };
    }
    env[name] = value;
  }
  return { ok: true, env };
}

/**
 * What the service exports into the project's commands: variable names
 * (the project's own rules for a name, so `PATH` and its kin are refused)
 * to templates over `{host}` and `{port}`, rendered when the service is
 * up — `DATABASE_URL: postgres://app:app@{host}:{port}/app`.
 */
export function validateServiceExports(
  input: unknown
): { ok: true; exports: Record<string, string> } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, exports: {} };
  if (!isRecord(input)) {
    return { ok: false, message: 'exports is an object of variable names to templates.' };
  }
  const entries = Object.entries(input);
  if (entries.length > SERVICE_EXPORT_MAX) {
    return { ok: false, message: `A service exports at most ${SERVICE_EXPORT_MAX} variables.` };
  }
  const exported: Record<string, string> = {};
  for (const [rawName, value] of entries) {
    const name = validateEnvName(rawName);
    if (!name.ok) return { ok: false, message: name.message };
    if (name.name.startsWith('SERVICE_')) {
      return {
        ok: false,
        message: `${name.name}: SERVICE_* names are set by the sandbox for every running service.`,
      };
    }
    if (typeof value !== 'string' || !value)
      return { ok: false, message: `${name.name}: a template is required.` };
    if (value.length > SERVICE_EXPORT_MAX_CHARS) {
      return {
        ok: false,
        message: `${name.name}: a template is at most ${SERVICE_EXPORT_MAX_CHARS} characters.`,
      };
    }
    exported[name.name] = value;
  }
  return { ok: true, exports: exported };
}

/** `db` → `SERVICE_DB`; `pg-16` → `SERVICE_PG_16`: the prefix of the variables announcing a running service. */
export function serviceEnvPrefix(name: string): string {
  return `SERVICE_${name.toUpperCase().replace(/-/g, '_')}`;
}

/** A template with its `{host}` and `{port}` filled in. */
export function renderServiceExport(
  template: string,
  service: { host: string; port: number | null }
): string {
  return template
    .replace(/\{host\}/g, service.host)
    .replace(/\{port\}/g, service.port === null ? '' : String(service.port));
}

/**
 * The variables a running service adds to every command in the project:
 * `SERVICE_<NAME>_HOST`, `SERVICE_<NAME>_PORT` (the lowest port the image
 * declares, when it declares any), `SERVICE_<NAME>_PORTS` (all of them,
 * comma-separated) and its exports rendered. Later services win over
 * earlier ones on a name they share, and the caller lets these win over
 * the project's own `.env` — a service is started to be what the tests
 * talk to.
 */
export function serviceEnvironment(
  services: Array<{ name: string; host: string; ports: number[]; exports: Record<string, string> }>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const service of services) {
    const prefix = serviceEnvPrefix(service.name);
    const port = service.ports.length ? Math.min(...service.ports) : null;
    env[`${prefix}_HOST`] = service.host;
    if (port !== null) env[`${prefix}_PORT`] = String(port);
    if (service.ports.length)
      env[`${prefix}_PORTS`] = [...service.ports].sort((a, b) => a - b).join(',');
    for (const [name, template] of Object.entries(service.exports)) {
      env[name] = renderServiceExport(template, { host: service.host, port });
    }
  }
  return env;
}

export function serviceLogLines(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SERVICE_LOGS_DEFAULT_LINES;
  return Math.max(1, Math.min(SERVICE_LOGS_MAX_LINES, Math.floor(value)));
}
