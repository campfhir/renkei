/**
 * The identity provider CLI: see or change the organization's OIDC record
 * straight in the database, for when nobody can sign in to do it in the
 * app (an expired client secret, a re-registered client). What it does is
 * ./idp.ts; DEPLOYMENT.md, "Replacing the identity provider's client
 * secret when nobody can sign in", is the runbook.
 *
 * Run from a checkout of the repository, with the web app's DATABASE_URL
 * and TOKEN_ENCRYPTION_KEY (or TOKEN_ENCRYPTION_KEYS) in the environment:
 *
 *   pnpm --filter @renkei/idp-cli idp show
 *   pnpm --filter @renkei/idp-cli idp set --client-secret
 *
 * It ships in no image: holding the database and the key is the authority.
 */

import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { loadKeyring } from '@renkei/crypto';
import { closeDataStore, getDataStore } from '@renkei/db';
import { USAGE, UsageError, applyChange, parseArgs, showIdp, summaryLines } from './idp';

/** A changed field, as the summary below names it. */
const FIELD_NAMES = {
  issuer: 'issuer',
  clientId: 'client id',
  clientSecret: 'client secret',
  roleClaim: 'role claim',
  operatorIdpValue: 'operator value',
  userIdpValue: 'user value',
  groupsClaim: 'groups claim',
} as const;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The new client secret: IDP_CLIENT_SECRET, piped standard input, or a prompt that does not echo. */
async function readClientSecret(): Promise<string> {
  const fromEnv = process.env.IDP_CLIENT_SECRET;
  if (fromEnv) return fromEnv.trim();

  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trim();
  }

  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    return await new Promise<string>((resolve) => {
      rl.question('New client secret (not shown): ', (answer) => resolve(answer.trim()));
      muted = true;
    });
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}

async function main(): Promise<void> {
  const command = parseArgs(process.argv.slice(2));
  if (command.kind === 'help') {
    console.log(USAGE);
    return;
  }

  if (!process.env.DATABASE_URL) fail('Database unavailable: set DATABASE_URL.');
  const keyring = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyring.ok) fail(`Keys: ${keyring.err.message ?? 'TOKEN_ENCRYPTION_KEY is not set'}`);

  try {
    const store = getDataStore();
    if (command.kind === 'show') {
      const summary = await showIdp(store, keyring.val);
      if (!summary) {
        console.log('No identity provider is configured. First-run setup (/setup) creates it.');
        return;
      }
      for (const line of summaryLines(summary)) console.log(line);
      return;
    }

    const change = { ...command.change };
    if (command.readSecret) change.clientSecret = await readClientSecret();
    const result = await applyChange(store, keyring.val, change);
    if (!result.ok) {
      fail(
        result.reason === 'empty-secret'
          ? 'No client secret was entered; nothing was changed.'
          : 'No identity provider is configured, so there is nothing to change. First-run setup (/setup, with SETUP_SECRET) creates it.'
      );
    }
    console.log(
      `Changed: ${result.changed.map((field) => FIELD_NAMES[field]).join(', ')}. The app uses it from the next sign-in.`
    );
    for (const line of summaryLines(result.summary)) console.log(line);
  } finally {
    await closeDataStore();
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) fail(`${error.message}\n\n${USAGE}`);
  fail(error instanceof Error ? error.message : String(error));
});
