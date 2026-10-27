import type { CrawlPage } from './types';
import { crawlId } from './types';

/**
 * Pages of this area the memory crawl visits; see ./types.ts. Rows that
 * belong to nobody (a log line, an OAuth client) are keyed off the crawl's
 * person, so a second visit to the same server never collides with the first.
 */

const CARD = crawlId(7101);
const HOME_CARD = crawlId(7102);
const CONSENT_REQUEST = crawlId(7103);
const AGENT = crawlId(7104);
const UTILIZATION_AGENT = crawlId(7105);
const NOTE = crawlId(7106);
const TOOL_CALL = crawlId(7107);
const HOUR_AGO = () => new Date(Date.now() - 3_600_000).toISOString();

function card(id: string, subject: string, title: string) {
  return {
    actionable_items: [
      {
        id,
        source: 'jira',
        kind: 'info',
        title,
        summary: 'Seeded for the memory crawl',
        evidence: JSON.stringify({}),
        owner_subject: subject,
      },
    ],
  };
}

export const generalPages: CrawlPage[] = [
  { path: '/about', expectText: 'What’s changed' },
  {
    path: '/notifications',
    seed: (subject) => ({
      agent_notifications: [
        { id: crawlId(1), subject, kind: 'agent_run', headline: 'Crawl notification' },
      ],
    }),
    expectText: 'Crawl notification',
  },
  { path: '/tutorials', expectText: 'Tutorials' },
  { path: '/admin/tutorials' },
  {
    path: '/',
    seed: (subject) => card(CARD, subject, 'Crawl feed card'),
    expectText: 'Crawl feed card',
  },
  {
    // The old address redirects to the feed, query string and all.
    path: '/home?archived=1',
    seed: (subject) => card(HOME_CARD, subject, 'Crawl history card'),
    expectText: 'Crawl history card',
  },
  {
    path: '/preferences',
    seed: (subject) => ({
      agents: [{ id: AGENT, name: `Crawl preferences agent ${subject}`, owner_subject: subject }],
    }),
    // The per-agent override picker only appears once the person owns an agent.
    expectText: /^Agent:$/,
  },
  {
    path: '/knowledge',
    // A note of the person's own: the one source whose gate needs no vendor.
    seed: (subject) => ({
      knowledge_chunks: [
        {
          id: NOTE,
          provider: 'note',
          ref_id: `${subject.toLowerCase()}/crawl-note`,
          content: 'enc',
          embedding: '[1,0,0]',
          metadata: JSON.stringify({ title: 'Crawl knowledge note' }),
          source_at: HOUR_AGO(),
        },
      ],
    }),
    expectText: 'Crawl knowledge note',
  },
  {
    path: '/logs',
    seed: () => ({
      logs: [{ level: 'ERROR', message: 'Crawl activity line', logged_timestamp: HOUR_AGO() }],
    }),
    expectText: 'Crawl activity line',
  },
  {
    path: '/usage',
    seed: (subject) => ({
      tool_calls: [
        {
          id: TOOL_CALL,
          tool: 'crawl_seeded_probe',
          connector: null,
          subject,
          status: 'ok',
          duration_ms: 42,
          started_at: HOUR_AGO(),
          ended_at: HOUR_AGO(),
        },
      ],
    }),
    expectText: /seeded probe/i,
  },
  {
    path: '/utilization',
    seed: (subject) => ({
      agents: [
        {
          id: UTILIZATION_AGENT,
          name: `Crawl utilization agent ${subject}`,
          owner_subject: subject,
          enabled: true,
        },
      ],
    }),
    expectText: 'Crawl utilization agent',
  },
  {
    path: `/oauth/consent?request=${CONSENT_REQUEST}`,
    seed: (subject, sessionId) => ({
      oauth_clients: [
        {
          client_id: `crawl-client-${subject}`,
          client_name: 'Crawl desktop client',
          client_secret_hash: 'none',
          redirect_uris: ['http://127.0.0.1:43123/callback'],
        },
      ],
      oauth_consent_requests: [
        {
          id: CONSENT_REQUEST,
          client_id: `crawl-client-${subject}`,
          session_id: sessionId,
          subject,
          redirect_uri: 'http://127.0.0.1:43123/callback',
          state: 'crawl',
          scope: 'openid profile email',
          code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
          code_challenge_method: 'S256',
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        },
      ],
    }),
    expectText: 'Allow Crawl desktop client to act as you?',
  },
  {
    // No identity provider in the memory store: the first-run page, not a redirect.
    path: '/setup',
    expectText: 'This deployment has no identity provider yet',
  },
];
