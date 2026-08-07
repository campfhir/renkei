/**
 * The reconciler's contract: a healthy tenant reconciles to "kept" with no
 * API writes; anything missing is created, anything inactive or signing
 * with the wrong secret is recreated, duplicates are deleted — and the
 * read-only inspection reports each of those states without repairing.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { WebexWebhook } from './client';
import {
  REQUIRED_WEBEX_WEBHOOKS,
  webexWebhookTargetUrl,
  inspectWebexWebhooks,
  ensureWebexWebhooks,
  type WebexWebhooksClient,
} from './webhooks-manager';

const TARGET = 'https://renkei.example.com/api/webhooks/webex/tenant-1';
const SECRET = 'signing-secret';

function hook(over: Partial<WebexWebhook>): WebexWebhook {
  return {
    id: 'hook-1',
    name: 'Renkei ingestion',
    targetUrl: TARGET,
    resource: 'messages',
    event: 'created',
    secret: SECRET,
    status: 'active',
    ...over,
  };
}

/** Both required registrations, healthy. */
function healthyPair(): WebexWebhook[] {
  return [
    hook({ id: 'hook-msg' }),
    hook({ id: 'hook-act', resource: 'attachmentActions', name: 'Renkei push-to-renkei' }),
  ];
}

interface StubCalls {
  created: Array<Record<string, unknown>>;
  deleted: string[];
}

function stubClient(hooks: WebexWebhook[]): { client: WebexWebhooksClient; calls: StubCalls } {
  const calls: StubCalls = { created: [], deleted: [] };
  let nextId = 1;
  return {
    calls,
    client: {
      listWebhooks: async () => ok(hooks),
      createWebhook: async (registration) => {
        calls.created.push({ ...registration });
        return ok(hook({ id: `new-${nextId++}`, ...registration }));
      },
      deleteWebhook: async (webhookId: string) => {
        calls.deleted.push(webhookId);
        return ok();
      },
    },
  };
}

describe('webexWebhookTargetUrl', () => {
  it('joins base and tenant, tolerating a trailing slash', () => {
    expect(webexWebhookTargetUrl('https://r.example.com/', 'tenant-1')).toBe(
      'https://r.example.com/api/webhooks/webex/tenant-1'
    );
  });
});

describe('inspectWebexWebhooks', () => {
  it('reports both registrations ok when both exist and are active', async () => {
    const { client } = stubClient(healthyPair());
    const result = await inspectWebexWebhooks(client, TARGET, SECRET);
    expect(result.ok && result.val.healthy).toBe(true);
    if (result.ok) {
      expect(result.val.registrations.map((r) => r.state)).toEqual(['ok', 'ok']);
    }
  });

  it('reports missing, inactive, and secret-mismatch distinctly', async () => {
    const { client } = stubClient([
      hook({ id: 'hook-msg', status: 'inactive' }),
      hook({ id: 'hook-act', resource: 'attachmentActions', secret: 'rotated-away' }),
    ]);
    const result = await inspectWebexWebhooks(client, TARGET, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.healthy).toBe(false);
      expect(result.val.registrations[0]?.state).toBe('inactive');
      expect(result.val.registrations[1]?.state).toBe('secret-mismatch');
    }
  });

  it('reports missing when nothing targets this tenant endpoint', async () => {
    const { client } = stubClient([hook({ targetUrl: 'https://other.example.com/hook' })]);
    const result = await inspectWebexWebhooks(client, TARGET, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.registrations.map((r) => r.state)).toEqual(['missing', 'missing']);
    }
  });

  it('reports duplicate when a healthy webhook has an extra sibling', async () => {
    const { client } = stubClient([...healthyPair(), hook({ id: 'hook-msg-dupe' })]);
    const result = await inspectWebexWebhooks(client, TARGET, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.registrations[0]?.state).toBe('duplicate');
      expect(result.val.healthy).toBe(false);
    }
  });
});

describe('ensureWebexWebhooks', () => {
  it('keeps a healthy pair untouched — idempotent, no writes', async () => {
    const { client, calls } = stubClient(healthyPair());
    const result = await ensureWebexWebhooks(client, { targetUrl: TARGET, secret: SECRET });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.changed).toBe(false);
      expect(result.val.registrations.map((r) => r.action)).toEqual(['kept', 'kept']);
    }
    expect(calls.created).toHaveLength(0);
    expect(calls.deleted).toHaveLength(0);
  });

  it('creates both registrations from nothing, with the tenant secret', async () => {
    const { client, calls } = stubClient([]);
    const result = await ensureWebexWebhooks(client, { targetUrl: TARGET, secret: SECRET });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.changed).toBe(true);
      expect(result.val.registrations.map((r) => r.action)).toEqual(['created', 'created']);
    }
    expect(calls.created).toHaveLength(REQUIRED_WEBEX_WEBHOOKS.length);
    expect(calls.created.map((c) => c.resource)).toEqual(['messages', 'attachmentActions']);
    expect(calls.created.every((c) => c.secret === SECRET && c.targetUrl === TARGET)).toBe(true);
  });

  it('recreates an inactive webhook — delete, then create', async () => {
    const { client, calls } = stubClient([
      hook({ id: 'hook-msg', status: 'inactive' }),
      hook({ id: 'hook-act', resource: 'attachmentActions' }),
    ]);
    const result = await ensureWebexWebhooks(client, { targetUrl: TARGET, secret: SECRET });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.registrations[0]?.action).toBe('recreated');
      expect(result.val.registrations[1]?.action).toBe('kept');
    }
    expect(calls.deleted).toEqual(['hook-msg']);
    expect(calls.created).toHaveLength(1);
  });

  it('recreates a webhook signing with the wrong secret', async () => {
    const { client, calls } = stubClient([
      hook({ id: 'hook-msg', secret: 'rotated-away' }),
      hook({ id: 'hook-act', resource: 'attachmentActions' }),
    ]);
    const result = await ensureWebexWebhooks(client, { targetUrl: TARGET, secret: SECRET });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.registrations[0]?.action).toBe('recreated');
    }
    expect(calls.deleted).toEqual(['hook-msg']);
  });

  it('treats a webhook whose secret is not echoed as matching', async () => {
    const { client, calls } = stubClient([
      hook({ id: 'hook-msg', secret: null }),
      hook({ id: 'hook-act', resource: 'attachmentActions', secret: null }),
    ]);
    const result = await ensureWebexWebhooks(client, { targetUrl: TARGET, secret: SECRET });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.changed).toBe(false);
    expect(calls.deleted).toHaveLength(0);
  });

  it('deletes duplicates but keeps the healthy one', async () => {
    const { client, calls } = stubClient([...healthyPair(), hook({ id: 'hook-msg-dupe' })]);
    const result = await ensureWebexWebhooks(client, { targetUrl: TARGET, secret: SECRET });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.registrations[0]?.action).toBe('deduplicated');
      expect(result.val.registrations[0]?.webhookId).toBe('hook-msg');
    }
    expect(calls.deleted).toEqual(['hook-msg-dupe']);
    expect(calls.created).toHaveLength(0);
  });

  it('leaves webhooks for other targets and resources alone', async () => {
    const foreign = hook({ id: 'foreign', targetUrl: 'https://other.example.com/hook' });
    const { client, calls } = stubClient([...healthyPair(), foreign]);
    const result = await ensureWebexWebhooks(client, { targetUrl: TARGET, secret: SECRET });
    expect(result.ok).toBe(true);
    expect(calls.deleted).toHaveLength(0);
  });

  it('propagates an API failure so the caller can retry the sweep', async () => {
    const { client } = stubClient([]);
    const failing = { ...client, listWebhooks: async () => err('WEBEX_API_ERROR' as const) };
    const result = await ensureWebexWebhooks(failing, { targetUrl: TARGET, secret: SECRET });
    expect(result.ok).toBe(false);
  });
});
