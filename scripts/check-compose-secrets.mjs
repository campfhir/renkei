#!/usr/bin/env node
// Fails when docker-compose.yaml hands a secret to a container that is not
// meant to hold it (audit R-03). Reads `docker compose config --format json`
// with a throwaway .env, so it checks what a container really receives.
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

const dir = mkdtempSync(join(tmpdir(), 'compose-secrets-'));
const envFile = join(dir, '.env');
const values = {};
let n = 0;
const names = [
  ...Object.keys(OWNERS),
  ...Object.keys(CALLER_KEYS),
  ...NEVER_ON_SANDBOX,
  'SANDBOX_WORKER_API_KEY',
  // Required by compose; every service's DATABASE_URL embeds it (audit R-13).
  'POSTGRES_PASSWORD',
];
for (const name of names) values[name] = `sentinel-${name.toLowerCase()}-${n++}`;
writeFileSync(
  envFile,
  Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + '\n'
);

const config = JSON.parse(
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

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`compose secrets: ${Object.keys(config.services).length} services checked`);
