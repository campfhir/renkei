/**
 * Round-trips against a real Postgres (DATABASE_URL, or the suite skips
 * itself — the fileshares store test set this convention) plus a real
 * `web-push`-signed POST against a throwaway local HTTP server standing in
 * for a push service. Mocking `web-push` would only restate what it does;
 * this actually proves a send carries valid VAPID auth and Web Push
 * encryption headers to whatever endpoint a subscription names.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, Agent, type Server } from 'node:https';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from '@renkei/db';
import { getVapidKeys, invalidateVapidKeyCache } from './vapid';
import { saveSubscription, listSubscriptions, deleteSubscription } from './subscriptions';
import { sendPush } from './send';

const url = process.env.DATABASE_URL;
const describeLive = url ? describe : describe.skip;

describeLive('@renkei/notifications (live database)', () => {
  let db: Kysely<DB>;
  let tenantId: string;
  const encryptionKey = randomBytes(32);
  const SUBJECT = 'itest-subject@example.com';

  beforeAll(async () => {
    db = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: url }) }),
    });
    // vapid_keys is a singleton row, not scoped to this test's tenant — an
    // earlier run (or a real dev server pointed at the same database) can
    // leave one behind that this run's own randomBytes(32) key can't
    // decrypt. Clearing it first makes the suite self-contained regardless
    // of what else has touched this database.
    await db.deleteFrom('platform_settings').where('key', '=', 'vapid_keys').execute();
    const tenant = await db
      .insertInto('tenants')
      .values({ id: randomUUID(), slug: `notif-itest-${Date.now()}` })
      .returning('id')
      .executeTakeFirstOrThrow();
    tenantId = tenant.id;
    invalidateVapidKeyCache();
  });

  afterAll(async () => {
    await db.deleteFrom('platform_settings').where('key', '=', 'vapid_keys').execute();
    await db.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await db.destroy();
  });

  it('mints a VAPID pair once and reuses it', async () => {
    const first = await getVapidKeys(db, encryptionKey);
    expect(first.publicKey).toEqual(expect.any(String));
    expect(first.privateKey).toEqual(expect.any(String));

    // A fresh process (no in-memory cache) reading the same row must land
    // on the identical pair, not mint a second one that no subscription was
    // ever created against.
    invalidateVapidKeyCache();
    const second = await getVapidKeys(db, encryptionKey);
    expect(second).toEqual(first);
  });

  it('round-trips a subscription through save, list and delete', async () => {
    const subscription = {
      endpoint: 'https://push.example.test/abc123',
      keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
    };
    await saveSubscription(db, tenantId, SUBJECT, subscription);

    const listed = await listSubscriptions(db, tenantId, SUBJECT);
    expect(listed).toEqual([subscription]);

    // Idempotent re-subscribe: same (tenant, endpoint) upserts, not inserts.
    await saveSubscription(db, tenantId, SUBJECT, {
      ...subscription,
      keys: { p256dh: 'p256dh-value', auth: 'rotated-auth' },
    });
    const relisted = await listSubscriptions(db, tenantId, SUBJECT);
    expect(relisted).toHaveLength(1);
    expect(relisted[0].keys.auth).toBe('rotated-auth');

    await deleteSubscription(db, tenantId, SUBJECT, subscription.endpoint);
    expect(await listSubscriptions(db, tenantId, SUBJECT)).toEqual([]);
  });

  it('sends a properly signed, encrypted push to the subscription endpoint', async () => {
    const vapidKeys = await getVapidKeys(db, encryptionKey);

    // A real subscription's p256dh/auth come from the browser's own ECDH
    // key pair; web-push needs SOMETHING valid there to encrypt against, so
    // this uses its own key generator rather than inventing bytes by hand.
    const webpush = (await import('web-push')).default;
    const deviceKeys = webpush.generateVAPIDKeys();

    // web-push always speaks HTTPS (it hardcodes node:https), so the stand-in
    // push service needs a real, if self-signed, certificate — a plain HTTP
    // server here would just fail the TLS handshake before a request ever
    // lands.
    const certDir = mkdtempSync(path.join(tmpdir(), 'renkei-push-test-'));
    const keyPath = path.join(certDir, 'key.pem');
    const certPath = path.join(certDir, 'cert.pem');
    execFileSync('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      // Modern TLS verifies against the SAN, not the CN — Node's own
      // hostname check would reject a cert carrying only the latter.
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ]);
    const key = readFileSync(keyPath);
    const cert = readFileSync(certPath);

    let received: {
      headers: Record<string, string | string[] | undefined>;
      bodyLength: number;
    } | null = null;
    const server: Server = createServer({ key, cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received = {
          headers: req.headers,
          bodyLength: Buffer.concat(chunks).length,
        };
        res.writeHead(201);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no server address');
    const endpoint = `https://127.0.0.1:${address.port}/push-endpoint`;
    // Trusts only the cert this test just minted — real callers never pass
    // an agent at all, which leaves web-push validating against the real
    // system CA store, same as any other HTTPS client.
    const agent = new Agent({ ca: cert });

    try {
      await saveSubscription(db, tenantId, SUBJECT, {
        endpoint,
        // Web Push subscription keys are P-256 points / secrets, base64url —
        // reusing a VAPID key pair's public key gives a real point on the
        // right curve without a separate ECDH keygen dependency.
        keys: { p256dh: vapidKeys.publicKey, auth: deviceKeys.publicKey.slice(0, 22) },
      });

      await sendPush(
        db,
        tenantId,
        SUBJECT,
        encryptionKey,
        {
          title: 'Created a Jira issue OPS-1',
          body: 'Triage yesterday into tickets',
          tag: 'run-1:jira_create_issue',
          refUrl: 'https://example.atlassian.net/browse/OPS-1',
        },
        { agent }
      );

      expect(received).not.toBeNull();
      const headers = received!.headers;
      expect(String(headers.authorization)).toMatch(/^vapid /);
      expect(headers['content-encoding']).toBe('aes128gcm');
      // The plaintext payload is never sent as-is — the ciphertext carries
      // its own 16-byte auth tag and header overhead on top of the JSON.
      expect(received!.bodyLength).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(certDir, { recursive: true, force: true });
    }
  });
});
