#!/usr/bin/env node
// Fails when docker-compose.yaml hands a secret to a container that is not
// meant to hold it (audit R-03), wires the database roles wrongly (R-13) or
// draws the network topology differently from what DEPLOYMENT.md says (R-06).
// Reads `docker compose config --format json` with a throwaway .env, so it
// checks what a container really receives.
//
//   node scripts/check-compose-secrets.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// secret -> the only services that may carry it
const OWNERS = {
  DELEGATE_WORKER_API_KEYS: ['worker-delegate'],
  USER_KEY_ENCRYPTION_KEY: ['worker-delegate'],
  FILESHARES_WORKER_API_KEY: ['worker-delegate', 'worker-fileshares'],
  ONBASE_WORKER_API_KEY: ['worker-delegate', 'worker-onbase'],
  MIRTH_WORKER_API_KEY: ['worker-delegate', 'worker-mirth'],
  ADMANAGER_WORKER_API_KEY: ['worker-delegate', 'worker-admanager'],
  SETUP_SECRET: ['renkei'],
  SANDBOX_ENV_SECRETS_KEY: ['migrate', 'worker-sandbox'],
};
// Each caller's own delegate key, presented as DELEGATE_WORKER_API_KEY.
const CALLER_KEYS = {
  DELEGATE_KEY_WEB: ['renkei'],
  DELEGATE_KEY_WORKER: ['worker', 'embeddings-worker', 'worker-batch-jobs'],
  DELEGATE_KEY_AGENTS: ['worker-agents'],
  DELEGATE_KEY_SANDBOX: ['worker-sandbox'],
};
// The sandbox runs untrusted code: no organisation-level encryption key.
const NEVER_ON_SANDBOX = [
  'TOKEN_ENCRYPTION_KEY',
  'TOKEN_ENCRYPTION_KEYS',
  'CONTENT_ENCRYPTION_KEY',
];

// Network topology (audit R-06). The sandbox worker is a Postgres client, so
// it shares a database-only network with postgres; the network it shares with
// the web app must reach no other worker and not the database.
const SANDBOX_NETWORK = 'renkei-sandbox';
const SANDBOX_DB_NETWORK = 'renkei-sandbox-db';
// Services that may sit on `renkei-sandbox`: the callers and callees of the
// sandbox worker, and the worker itself.
const SANDBOX_NETWORK_MEMBERS = [
  'renkei',
  'worker-delegate',
  'worker-batch-jobs',
  'worker-sandbox',
];

const dir = mkdtempSync(join(tmpdir(), 'compose-secrets-'));
const values = {};
let n = 0;
const names = [
  ...Object.keys(OWNERS),
  ...Object.keys(CALLER_KEYS),
  ...NEVER_ON_SANDBOX,
  'SANDBOX_WORKER_API_KEY',
  // Required by compose; every service's DATABASE_URL embeds it (audit R-13).
  'POSTGRES_PASSWORD',
  'PUBLIC_BASE_URL',
];
for (const name of names) values[name] = `sentinel-${name.toLowerCase()}-${n++}`;

/** The compose config for the base .env plus `extra`, in its own env file. */
function render(label, extra = {}) {
  const envFile = join(dir, `${label}.env`);
  writeFileSync(
    envFile,
    Object.entries({ ...values, ...extra })
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n'
  );
  return JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '-f',
        'docker-compose.yaml',
        '--env-file',
        envFile,
        '--profile',
        '*',
        'config',
        '--format',
        'json',
      ],
      { encoding: 'utf8' }
    )
  );
}

const config = render('default');
const problems = [];

for (const [service, def] of Object.entries(config.services)) {
  if (def.env_file) problems.push(`${service}: uses env_file, which hands it the whole .env`);
  const carried = Object.entries(def.environment ?? {});
  const holds = (name) =>
    carried.some(([, v]) => typeof v === 'string' && v.includes(values[name]));
  for (const [name, services] of Object.entries(OWNERS)) {
    if (holds(name) && !services.includes(service)) problems.push(`${service}: carries ${name}`);
  }
  for (const [name, services] of Object.entries(CALLER_KEYS)) {
    if (holds(name) && !services.includes(service) && service !== 'worker-delegate') {
      problems.push(`${service}: carries ${name}`);
    }
  }
  if (service === 'worker-sandbox') {
    for (const name of NEVER_ON_SANDBOX)
      if (holds(name)) problems.push(`${service}: carries ${name}`);
  }
}

// --- Network topology (R-06) -------------------------------------------
const networksOf = (service) => Object.keys(config.services[service]?.networks ?? {});
const membersOf = (network) =>
  Object.keys(config.services).filter((service) => networksOf(service).includes(network));

for (const service of ['postgres', 'worker-sandbox']) {
  if (!config.services[service]) problems.push(`${service}: missing from the compose file`);
}
if (config.services.postgres && config.services['worker-sandbox']) {
  const shared = networksOf('postgres').filter((net) => networksOf('worker-sandbox').includes(net));
  if (shared.length === 0) {
    problems.push(
      'postgres and worker-sandbox share no network: the sandbox worker has no route to its database'
    );
  }
  if (!shared.includes(SANDBOX_DB_NETWORK)) {
    problems.push(`postgres and worker-sandbox must share ${SANDBOX_DB_NETWORK}`);
  }
  if (shared.includes(SANDBOX_NETWORK)) {
    problems.push(`postgres is on ${SANDBOX_NETWORK}, which every workspace command can reach`);
  }
}
const dbNetwork = config.networks?.[SANDBOX_DB_NETWORK];
if (!dbNetwork) {
  problems.push(`network ${SANDBOX_DB_NETWORK} is not defined`);
} else {
  if (dbNetwork.internal !== true) problems.push(`${SANDBOX_DB_NETWORK} must be internal`);
  const members = membersOf(SANDBOX_DB_NETWORK).sort().join(', ');
  if (members !== 'postgres, worker-sandbox') {
    problems.push(
      `${SANDBOX_DB_NETWORK} may hold only postgres and worker-sandbox, holds: ${members}`
    );
  }
}
for (const member of membersOf(SANDBOX_NETWORK)) {
  if (!SANDBOX_NETWORK_MEMBERS.includes(member)) {
    problems.push(`${member} is on ${SANDBOX_NETWORK}: the sandbox container could reach it`);
  }
}
if (config.services['worker-sandbox']) {
  const sandboxNets = networksOf('worker-sandbox').sort().join(', ');
  const expected = [SANDBOX_DB_NETWORK, SANDBOX_NETWORK].sort().join(', ');
  if (sandboxNets !== expected) {
    problems.push(`worker-sandbox must be on exactly ${expected}, is on: ${sandboxNets}`);
  }
}

// --- Database roles (R-13) -----------------------------------------------
const OWNER_URL = `postgres://renkei:${values.POSTGRES_PASSWORD}@postgres:5432/renkei`;
const databaseUrl = (cfg, service) => cfg.services[service]?.environment?.DATABASE_URL;

// Unset: the single role, exactly as before the roles existed.
for (const service of Object.keys(config.services)) {
  const url = databaseUrl(config, service);
  if (url !== undefined && url !== OWNER_URL) {
    problems.push(
      `${service}: with no runtime role configured its DATABASE_URL is not the owner's`
    );
  }
}

// Set: only `migrate` keeps the owner; the sandbox gets its own role.
const RUNTIME_USER = 'renkei_app';
const RUNTIME_PASSWORD = 'sentinel-runtime-password';
const SANDBOX_USER = 'renkei_sandbox';
const SANDBOX_PASSWORD = 'sentinel-sandbox-password';
const withRoles = render('roles', {
  RENKEI_RUNTIME_DB_USER: RUNTIME_USER,
  RENKEI_RUNTIME_DB_PASSWORD: RUNTIME_PASSWORD,
  RENKEI_SANDBOX_DB_USER: SANDBOX_USER,
  RENKEI_SANDBOX_DB_PASSWORD: SANDBOX_PASSWORD,
});
const runtimeUrl = `postgres://${RUNTIME_USER}:${RUNTIME_PASSWORD}@postgres:5432/renkei`;
const sandboxUrl = `postgres://${SANDBOX_USER}:${SANDBOX_PASSWORD}@postgres:5432/renkei`;
for (const service of Object.keys(withRoles.services)) {
  const url = databaseUrl(withRoles, service);
  const expected =
    service === 'migrate' ? OWNER_URL : service === 'worker-sandbox' ? sandboxUrl : runtimeUrl;
  if (url === undefined) {
    if (service !== 'postgres') problems.push(`${service}: carries no DATABASE_URL`);
    continue;
  }
  if (url !== expected)
    problems.push(`${service}: with roles configured it connects as the wrong role`);
  const env = JSON.stringify(withRoles.services[service].environment ?? {});
  if (service !== 'migrate' && service !== 'postgres' && env.includes(values.POSTGRES_PASSWORD)) {
    problems.push(`${service}: carries the owner's password while a runtime role is configured`);
  }
  if (service !== 'worker-sandbox' && env.includes(SANDBOX_PASSWORD) && service !== 'migrate') {
    problems.push(`${service}: carries the sandbox role's password`);
  }
}
const migrateEnv = withRoles.services.migrate?.environment ?? {};
if (
  migrateEnv.RENKEI_RUNTIME_DB_USER !== RUNTIME_USER ||
  migrateEnv.RENKEI_SANDBOX_DB_USER !== SANDBOX_USER
) {
  problems.push('migrate: does not receive the role variables it creates the roles from');
}

// Runtime role only: the sandbox falls back to it rather than to the owner.
const runtimeOnly = render('runtime-only', {
  RENKEI_RUNTIME_DB_USER: RUNTIME_USER,
  RENKEI_RUNTIME_DB_PASSWORD: RUNTIME_PASSWORD,
});
if (databaseUrl(runtimeOnly, 'worker-sandbox') !== runtimeUrl) {
  problems.push('worker-sandbox: without its own role it must use the runtime role, not the owner');
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`compose secrets: ${Object.keys(config.services).length} services checked`);
