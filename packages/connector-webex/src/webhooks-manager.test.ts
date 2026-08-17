/**
 * The reconciler's contract: a healthy tenant reconciles to "kept" with no
 * API writes; anything missing is created, anything inactive or signing
 * with the wrong secret is recreated, duplicates are deleted — and the
 * read-only inspection reports each of those states without repairing.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { WebexWebhook } from './client';
import {
  USER_SPACES_WEBHOOKS,
  webexUserWebhookTargetUrl,
  inspectWebexWebhooks,
  ensureWebexWebhooks,
  deleteWebexWebhooksFor,
  type WebexWebhooksClient,
} from './webhooks-manager';

const TARGET = 'https://renkei.example.com/api/webhooks/webex/tenant-1/user/acct-1';
const SECRET = 'signing-secret';

function hook(over: Partial<WebexWebhook>): WebexWebhook {
  return {
    id: 'hook-1',
    name: 'Renkei all spaces',
    targetUrl: TARGET,
    resource: 'messages',
    event: 'created',
    secret: SECRET,
    status: 'active',
    ...over,
  };
}

/** The one required registration, healthy. */
function healthyPair(): WebexWebhook[] {
  return [hook({ id: 'hook-msg' })];
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

describe('webexUserWebhookTargetUrl', () => {
  it('joins base, tenant and account, tolerating a trailing slash', () => {
    expect(webexUserWebhookTargetUrl('https://r.example.com/', 'tenant-1', 'acct 1')).toBe(
      'https://r.example.com/api/webhooks/webex/tenant-1/user/acct%201'
    );
  });
});

describe('inspectWebexWebhooks', () => {
  it('reports both registrations ok when both exist and are active', async () => {
    const { client } = stubClient(healthyPair());
    const result = await inspectWebexWebhooks(client, TARGET, SECRET);
    expect(result.ok && result.val.healthy).toBe(true);
    if (result.ok) {
      expect(result.val.registrations.map((r) => r.state)).toEqual(['ok']);
    }
  });

  it('reports inactive and secret-mismatch distinctly', async () => {
    const inactive = await inspectWebexWebhooks(
      stubClient([hook({ id: 'hook-msg', status: 'inactive' })]).client,
      TARGET,
      SECRET
    );
    expect(inactive.ok && inactive.val.registrations[0]?.state).toBe('inactive');

    const mismatch = await inspectWebexWebhooks(
      stubClient([hook({ id: 'hook-msg', secret: 'rotated-away' })]).client,
      TARGET,
      SECRET
    );
    expect(mismatch.ok && mismatch.val.registrations[0]?.state).toBe('secret-mismatch');
  });

  it('reports missing when nothing targets this tenant endpoint', async () => {
    const { client } = stubClient([hook({ targetUrl: 'https://other.example.com/hook' })]);
    const result = await inspectWebexWebhooks(client, TARGET, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.registrations.map((r) => r.state)).toEqual(['missing']);
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
      expect(result.val.registrations.map((r) => r.action)).toEqual(['kept']);
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
      expect(result.val.registrations.map((r) => r.action)).toEqual(['created']);
    }
    expect(calls.created).toHaveLength(USER_SPACES_WEBHOOKS.length);
    expect(calls.created.map((c) => c.resource)).toEqual(['messages']);
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

describe('deleteWebexWebhooksFor', () => {
  it('deletes exactly the hooks pointing at the target, idempotently', async () => {
    const { client, calls } = stubClient([
      hook({ id: 'hook-msg' }),
      hook({ id: 'other', targetUrl: 'https://elsewhere.example.com/hook' }),
    ]);
    const result = await deleteWebexWebhooksFor(client, TARGET);
    expect(result.ok && result.val.deleted).toBe(1);
    expect(calls.deleted).toEqual(['hook-msg']);

    const empty = await deleteWebexWebhooksFor(stubClient([]).client, TARGET);
    expect(empty.ok && empty.val.deleted).toBe(0);
  });
});
