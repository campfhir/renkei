import { randomUUID } from 'node:crypto';
import type { CrawlPage } from './types';
import { crawlId } from './types';

/**
 * Pages of this area the memory crawl visits; see ./types.ts.
 *
 * Organization-wide rows (audit events, the event queue, model and
 * calendar rosters, the IdP record) are not reset with the crawl's person,
 * so they get fresh ids and names on each seed rather than fixed ones.
 */
const fresh = () => randomUUID();
const suffix = () => randomUUID().slice(0, 8);

export const adminPages: CrawlPage[] = [
  { path: '/admin', expectText: 'Organization' },
  {
    path: '/admin/access',
    seed: (subject) => ({
      provider_grants: [
        {
          provider: 'microsoft',
          provider_account_id: `crawl-${subject}`,
          subject,
          display_name: 'Crawl Access Grant',
          client_id: 'crawl',
          encrypted_access_token: 'sealed',
          encrypted_refresh_token: 'sealed',
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
    }),
    expectText: 'Crawl Access Grant',
  },
  {
    path: '/admin/audit',
    seed: (subject) => ({
      audit_events: [
        {
          id: fresh(),
          actor_subject: subject,
          action: 'agent.created',
          target_kind: 'agent',
          target_label: 'Crawl audit agent',
        },
      ],
    }),
    expectText: 'Crawl audit agent',
  },
  {
    path: '/admin/events',
    seed: (subject) => ({
      events: [
        {
          id: fresh(),
          source: 'crawl-events-source',
          type: 'crawl.event',
          payload: JSON.stringify({ ownerSubject: subject }),
        },
      ],
    }),
    expectText: 'crawl-events-source',
  },
  {
    path: '/admin/sites',
    seed: (subject) => ({
      content_watches: [
        {
          id: crawlId(201),
          provider: 'atlassian',
          subject,
          account_id: 'crawl-account',
          scope_type: 'space',
          scope_key: 'CRAWL',
          scope_label: 'Crawl Watched Space',
        },
      ],
    }),
    expectText: 'Crawl Watched Space',
  },
  {
    path: '/admin/settings',
    seed: () => ({
      oidc_config: [
        {
          id: fresh(),
          issuer: `https://crawl-idp-${suffix()}.example.test`,
          client_id: 'crawl',
          client_secret: 'sealed',
        },
      ],
    }),
    expectText: /crawl-idp-/,
  },
  { path: '/admin/storage', expectText: 'Storage' },
  {
    path: '/admin/usage',
    seed: (subject) => ({
      chats: [{ id: crawlId(202), owner_subject: subject }],
      chat_turns: [
        {
          id: crawlId(203),
          chat_id: crawlId(202),
          status: 'completed',
          input_tokens: 4321,
          output_tokens: 1234,
        },
      ],
    }),
    // The seeded turn's tokens, on the chat surface.
    expectText: '4.3k in · 1.2k out',
  },
  { path: '/admin/grants', expectText: 'Access' },
  { path: '/admin/redaction', expectText: 'Sensitive data' },
  {
    path: '/admin/llm-models',
    seed: () => ({
      llm_model_configs: [
        {
          id: fresh(),
          label: `Crawl Model ${suffix()}`,
          provider: 'anthropic',
          model: 'crawl-model',
          encrypted_secrets: 'sealed',
          settings: JSON.stringify({}),
        },
      ],
    }),
    expectText: /Crawl Model/,
  },
  { path: '/admin/code-services', expectText: 'Code services' },
  { path: '/admin/pipeline-templates' },
  { path: '/admin/project-templates' },
  {
    path: '/admin/calendars',
    seed: () => ({
      schedule_calendars: [
        { id: fresh(), name: `Crawl Calendar ${suffix()}`, dates: JSON.stringify([]) },
      ],
    }),
    expectText: /Crawl Calendar/,
  },
];
