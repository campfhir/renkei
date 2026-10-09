/**
 * Shared utilities for MCP tools.
 *
 * Adapted from renkei for Next.js context.
 */

import { z } from 'zod';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { delegateRefusal, type AuthedFetch } from '@renkei/delegate-client';
import { logger, secure } from '@/lib/logger';
import { grantRefusalText } from '@/lib/grant-refusals';
import {
  REQUEST_TIMEOUT_MS,
  UPLOAD_TIMEOUT_MS,
  isTimeoutError,
  timeoutSignal,
} from './fetch-guard';

export interface MCPToolContext {
  accountId: string;
  /**
   * Bare site domain (https://your-domain.atlassian.net). Browser links only —
   * `/browse/...`, boards, the JSM portal. OAuth 2.0 (3LO) bearer tokens are not
   * accepted here; use apiBaseUrl for anything under /rest.
   */
  siteUrl: string;
  /**
   * API gateway base (https://api.atlassian.com/ex/jira/{cloudId}). Every REST
   * call must go through this — 3LO tokens are rejected on the bare site domain.
   */
  apiBaseUrl: string;
  /**
   * The Atlassian cloud id on its own, for APIs that embed it differently
   * than apiBaseUrl does — JSM Operations lives at
   * api.atlassian.com/ex/jira/{cloudId}/jsm/ops/api/v1.
   */
  cloudId?: string;
  /**
   * The caller's Jira grant as a fetcher (docs/delegate-key-design.md): the
   * delegate worker holds the token, attaches it, refreshes it when due and
   * retries once on a 401. Null when the caller has no Jira grant, and in
   * the tool catalog's enumeration-only context, where nothing may reach
   * Atlassian.
   */
  jiraAuth: AuthedFetch | null;
  maxJqlResults: number;
  /**
   * Public origin of this deployment (https://mcp.example.com), for links the
   * user must be able to open — the internal request URL behind a reverse
   * proxy is not reachable from outside.
   */
  origin?: string;
  /** Org limit for attachment uploads, from org settings. */
  maxAttachmentBytes?: number;
  /**
   * The caller's recorded email (identity spine), which the knowledge gate
   * verifies provider access against. Absent = gates fail closed.
   */
  userEmail?: string;
  /**
   * The caller's OIDC subject — the key for grants that are looked up per
   * call rather than resolved into the context (the WebEx user grant).
   */
  subject?: string;
  /**
   * The scopes the caller's Atlassian grant actually carries. Tool
   * registration filters on these; undefined (pre-recording grants) means no
   * filtering.
   */
  grantedScopes?: string[];
  /** Same, for the caller's WebEx user grant when one exists. */
  webexScopes?: string[];
  /** Same, for the caller's Microsoft grant when one exists. */
  graphScopes?: string[];
  /**
   * Same, for the caller's Zoom grant — but computed as requested ∩ granted
   * (or bare requested when granted is unknown): Zoom tokens always carry
   * the Marketplace app's full scope set, so bare granted would erase the
   * user's narrowing.
   */
  zoomScopes?: string[];
  /**
   * The caller's grant on the second Atlassian app ("Renkei JSM": JSM + Ops
   * scopes), when connected. JSM/Ops tools run on THIS grant; absent, they
   * fall back to the main grant — the pre-split single-app shape.
   */
  jsmGrant?: {
    /** The JSM grant's fetcher; null in the enumeration-only catalog context. */
    auth: AuthedFetch | null;
    cloudId: string;
    accountId: string;
    scopes?: string[];
  };
  /**
   * Same, for the caller's grant on the third Atlassian app ("Renkei
   * Confluence"). Unlike jsmGrant above, Confluence tools don't reuse
   * Jira's apiBaseUrl/jiraAuth context fields — Confluence is a
   * different product with its own gateway path, so each tool resolves
   * its own access fresh per call (Outlook/WebEx/Zoom-style). Only the
   * scopes are needed on the context, for the registration-time gate.
   */
  confluenceScopes?: string[];
  /**
   * Same, for the caller's grant on the fourth Atlassian app ("Renkei
   * Bitbucket") — computed as requested ∩ granted (or bare requested when
   * granted is unknown), the Zoom arrangement: Bitbucket fixes scopes on
   * the OAuth consumer, so the token always carries the consumer's full
   * set and bare granted would erase the user's narrowing.
   */
  bitbucketScopes?: string[];
  /**
   * Same, for the caller's grant on Renkei's GitHub App — computed as
   * requested ∩ granted (or bare requested when granted is unknown), the
   * same Bitbucket/Zoom arrangement: a GitHub App's real permissions are
   * fixed on the App's registration, not requested per authorize call, so
   * bare granted would erase the user's narrowing.
   */
  githubScopes?: string[];
  /**
   * Same, for the caller's grant on the fifth Atlassian app ("Renkei Jira
   * Admin"): its CLASSIC scopes, for the registration-time gate. The
   * jira_admin_ tools resolve their token fresh per call, Confluence-style
   * (jira-admin/client.ts), rather than riding Jira's context fields.
   */
  jiraAdminScopes?: string[];
  /**
   * Same, for the caller's grant on the Entra Developer app registration —
   * the SECOND Entra app, its own grant (ENTRA_DEVELOPER): its delegated
   * Graph scopes, for the registration-time gate. The entra_ tools resolve
   * their token fresh per call (entra-developer/client.ts), never from the
   * Microsoft 365 grant's graphScopes.
   */
  entraDeveloperScopes?: string[];
  /**
   * Present when the caller is an agent run (an agent-runner token,
   * migration 040). `subject`/`userEmail` still name the run OWNER — every
   * gate applies as if the owner called — this only says an agent is doing
   * the calling, so tools can stamp provenance (authoredBy, created_by)
   * without loosening any owner-scoped check.
   */
  agent?: { agentId: string };
  /**
   * The caller's renkei roles (migration 091), carried onto their MCP
   * token from the browser session that authorized it — see
   * lib/mcp-token.ts's AccessTokenRecord. Registration-time role gating
   * (which tools even appear) goes through withCapabilityGate's
   * requiredRole instead; this is for a handler that needs to branch on
   * role within an already-registered tool's own logic. Empty for tokens
   * issued before this migration or for an 'agent' token.
   */
  roles?: string[];
  db?: Kysely<DB>;
}

/**
 * Jira project keys are uppercase alphanumeric; the numeric suffix is the
 * issue number. Validating here keeps a crafted key from being interpolated
 * into a path.
 */
export const issueKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*-\d+$/, 'must look like PROJ-123 (uppercase project key, dash, number)');

/** Project keys without the issue number, for creation. */
export const projectKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, 'must be an uppercase project key, e.g. SCRUM');

const KEYWORD_MAX_CHARS = 60;
const MAX_KEYWORDS = 20;

/**
 * Up to 20 short search keywords/phrases, submitted by the calling model
 * itself (knowledge/agent notes). A model asked for "keywords" sometimes
 * writes one comma-separated string instead of a JSON array — the same
 * shape mismatch `arrayValue` in jira/field-schema.ts normalizes for Jira's
 * multi-value fields. Left unhandled, that string reaches the array schema
 * as the wrong top-level type; zod's `.max()` on the array then also
 * evaluates against the string's own `.length` (a real quirk, not a typo)
 * and reports a second, misleading "<=20 characters" issue alongside it.
 * Splitting a string into members before the array schema ever sees it
 * avoids both, and accepts what the model actually sent.
 */
export function keywordsFieldSchema(description: string) {
  return z
    .preprocess(
      (value) =>
        typeof value === 'string'
          ? value
              .split(',')
              .map((part) => part.trim())
              .filter(Boolean)
          : value,
      z.array(z.string().min(1).max(KEYWORD_MAX_CHARS)).max(MAX_KEYWORDS).optional()
    )
    .describe(description);
}

export interface MCPToolResult {
  type: 'text' | 'image' | 'resource';
  text?: string;
  url?: string;
  data?: string;
  mimeType?: string;
}

export function ok(text: string): MCPToolResult {
  return { type: 'text', text };
}

export function okWithLink(text: string, url: string): MCPToolResult {
  return { type: 'text', text: `${text}\n\n[Open in Jira](${url})` };
}

export function toolError(text: string): MCPToolResult {
  return { type: 'text', text };
}

/**
 * A trailing note appended to a list/detail-shaped tool result, nudging the
 * calling model toward a more scannable reply than echoing this flat text
 * back verbatim — a table, a card, a grouped layout, whatever fits the data
 * — without dictating exactly what that looks like. Cheap to add, easy to
 * ignore when a flat list is already the right call (a couple of results,
 * or the user asked for raw output). Shared across connectors so every tool
 * file (Jira, JSM, WebEx, Zoom, Outlook) phrases this the same way; see
 * `apps/web/lib/mcp-tools/outlook/index.ts` for the pattern this generalized
 * from.
 */
export function withPresentationHint(body: string, suggestion: string): string {
  return `${body}\n\n(Presentation hint: ${suggestion})`;
}

/** Generate a link to a Jira issue. */
export function issueUrl(siteUrl: string, issueKey: string): string {
  return `${siteUrl}/browse/${issueKey}`;
}

/** Generate a link to a Jira sprint board. */
export function sprintUrl(siteUrl: string, boardId: string | number): string {
  return `${siteUrl}/software/projects/SCRUM/boards/${boardId}`;
}

/** Generate a link to a Jira service desk request. */
export function requestUrl(siteUrl: string, requestKey: string): string {
  return `${siteUrl}/servicedesk/customer/portals/all/requests/${requestKey}`;
}

/**
 * Cache for accountId -> displayName mapping.
 * Updated whenever user info is fetched, expires after 24h.
 */
interface UserMetadata {
  displayName: string;
  expiresAt: number;
}
const userMetadataCache = new Map<string, UserMetadata>();

/**
 * Store user displayName for 24h TTL lookup.
 */
export function cacheUserDisplayName(accountId: string, displayName: string): void {
  userMetadataCache.set(accountId, {
    displayName,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });
}

/**
 * Retrieve cached displayName if still valid.
 */
export function getCachedDisplayName(accountId: string): string | undefined {
  const cached = userMetadataCache.get(accountId);
  if (!cached || cached.expiresAt < Date.now()) {
    userMetadataCache.delete(accountId);
    return undefined;
  }
  return cached.displayName;
}

/**
 * Pull a human-readable reason out of an Atlassian error body. Jira returns
 * `{errorMessages: [...], errors: {...}}`, JSM returns `{errorMessage: "..."}`,
 * and a removed endpoint may return HTML or nothing at all.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Failure {
  reason: string;
  /**
   * Jira's per-field complaints, keyed by field id. Kept structured as well as
   * flattened into `reason`, because a caller that can retry without a refused
   * field needs to know which field that was, and the prose is not parseable.
   */
  fieldErrors: Record<string, string>;
  /** The full response body text, for the failure log — reason is a summary. */
  raw: string;
}

async function describeFailure(response: Response): Promise<Failure> {
  const body = await response.text().catch(() => '');
  if (!body)
    return { reason: response.statusText || `HTTP ${response.status}`, fieldErrors: {}, raw: '' };

  try {
    const parsed: unknown = JSON.parse(body);
    if (isPlainObject(parsed)) {
      const fieldErrors: Record<string, string> = {};
      if (isPlainObject(parsed.errors)) {
        for (const [field, message] of Object.entries(parsed.errors)) {
          fieldErrors[field] = String(message);
        }
      }

      // errorMessages first, as before: it holds the whole-request complaint,
      // while `errors` details individual fields. Both are reported.
      const parts: string[] = [];
      if (Array.isArray(parsed.errorMessages) && parsed.errorMessages.length > 0) {
        parts.push(parsed.errorMessages.join('; '));
      }
      if (typeof parsed.errorMessage === 'string' && parsed.errorMessage) {
        parts.push(parsed.errorMessage);
      }
      const fieldPart = Object.entries(fieldErrors)
        .map(([field, message]) => `${field}: ${message}`)
        .join('; ');
      if (fieldPart) parts.push(fieldPart);

      if (parts.length > 0) return { reason: parts.join(' | '), fieldErrors, raw: body };
    }
  } catch {
    // Not JSON — fall through to the truncated raw body.
  }

  return { reason: body.slice(0, 300), fieldErrors: {}, raw: body };
}

/**
 * The grant behind an `AuthedFetch`, read off its `grantKey`
 * (`provider:tenant:account-or-subject`) for log context. Never a token:
 * these records are persisted by the Postgres log adapter and are readable
 * over HTTP.
 */
function grantScope(auth: AuthedFetch): { tenantId?: string; accountId?: string } {
  const [, tenantId, accountId] = auth.grantKey.split(':');
  return { tenantId: tenantId || undefined, accountId: accountId || undefined };
}

/**
 * Make an authenticated request to the Jira API on the caller's grant. The
 * delegate behind `auth` attaches the credential, refreshes it when due and
 * retries once on a 401 — so a 401 that reaches here is Atlassian's final
 * word, and a refusal the delegate issued itself (no grant, revoked, host
 * not allowed) is told apart by `delegateRefusal`.
 *
 * Throws JiraApiError on any non-2xx. This previously returned the response
 * untouched "so callers can handle non-ok statuses" — but no caller ever did,
 * so a 404 or 410 was parsed as JSON, failed an `isArray(data.issues)` check,
 * and surfaced as "no results" or even a false success message. Failing loudly
 * here is what makes a wrong endpoint visible instead of silently empty.
 */
export async function jiraFetch(
  url: string,
  auth: AuthedFetch,
  options?: RequestInit
): Promise<Response> {
  const scope = grantScope(auth);
  const displayName = scope.accountId ? getCachedDisplayName(scope.accountId) : undefined;
  logger.debug('Request', {
    component: 'jira/fetch',
    accountId: scope.accountId,
    displayName,
    url,
    method: options?.method || 'GET',
  });

  // A FormData body must carry its own multipart boundary, so no Content-Type
  // may be preset for it — fetch generates the header from the body.
  const contentTypeHeader: Record<string, string> =
    options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
  // A stalled upstream must become an error the caller can render, never a
  // tool call that hangs while the MCP stream keepalives forever. Multipart
  // uploads get the long budget — 20MB on a slow link is minutes, not 15s.
  const timeoutMs = options?.body instanceof FormData ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS;

  // No Authorization here: the delegate attaches it, and drops one a caller sets.
  const headers = {
    Accept: 'application/json',
    ...contentTypeHeader,
    ...options?.headers,
  };

  let response: Response;
  try {
    response = await auth(url, {
      ...options,
      headers,
      signal: timeoutSignal(options ?? {}, timeoutMs),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new JiraApiError(
        `Jira API request timed out after ${timeoutMs}ms — the site may be slow or unreachable`,
        504
      );
    }
    throw new JiraApiError('Could not reach the Jira API', 502);
  }
  logger.debug('Response', {
    component: 'jira/fetch',
    accountId: scope.accountId,
    url,
    status: response.status,
  });

  // The delegate's own refusal never reached Atlassian: a missing or revoked
  // grant, a failed refresh, a host outside the provider's own. Said in the
  // words the resolvers used to return, so a handler renders it unchanged.
  const refusal = delegateRefusal(response);
  if (refusal) {
    logger.warn('Delegate refused the Jira call', {
      component: 'jira/fetch',
      accountId: scope.accountId,
      url,
      refusal,
    });
    throw new JiraApiError(
      refusal === 'GRANT_REVOKED' ? 'GRANT_REVOKED' : grantRefusalText(refusal, 'Jira'),
      response.status,
      refusal === 'GRANT_REVOKED' || refusal === 'NO_GRANT' || refusal === 'REFRESH_FAILED'
    );
  }

  if (!response.ok) {
    const failure = await describeFailure(response);
    // Every failure (401/403 included) logs the full exchange — request
    // payload and response body, scoped to tenant and OIDC user — because a
    // status plus a one-line reason was repeatedly not enough to diagnose
    // anything. The Authorization header never reaches the log, and the
    // bodies are secure()-marked: they can carry user content (comments,
    // descriptions), so the console masks them, and the Postgres adapter
    // encrypts them at rest once encrypt/decrypt keys are configured.
    logger.warn('Non-OK response', {
      component: 'jira/fetch',
      accountId: scope.accountId,
      displayName,
      url,
      method: options?.method || 'GET',
      status: response.status,
      reason: failure.reason,
      requestBody: secureOrAbsent(describeRequestBody(options?.body)),
      responseBody: secureOrAbsent(truncateForLog(failure.raw) || undefined),
    });
    throw new JiraApiError(
      `Jira API ${response.status}: ${failure.reason}`,
      response.status,
      response.status === 401,
      failure.fieldErrors
    );
  }

  // Successful exchanges log the shape of the call, never its payloads.
  // They used to carry both bodies (secure()-marked) so a 2xx that did the
  // WRONG thing could be diagnosed from the log — but that persisted a copy
  // of every issue, comment and page a tenant's users touched into the logs
  // table for the retention window, readable over HTTP by tenant users. The
  // failure path below keeps its bodies: a 4xx/5xx is rare, is what actually
  // needs diagnosing, and carries the provider's complaint rather than the
  // user's content.
  logger.debug('OK response', {
    component: 'jira/fetch',
    accountId: scope.accountId,
    displayName,
    url,
    method: options?.method || 'GET',
    status: response.status,
  });

  return response;
}

/** secure()-mark a body when present; undefined stays undefined, not '[secure]'. */
function secureOrAbsent(value: string | undefined) {
  return value === undefined ? undefined : secure(value);
}

/** Cap a logged body: enough to diagnose, bounded against megabyte payloads. */
function truncateForLog(text: string): string {
  // 1300, not more: secure() bodies encrypt to ~1.4x base64url, and values
  // past ~2KB fall into blob storage where the adapter does not decrypt on
  // read — 1300 keeps the ciphertext inline, so the viewer shows plaintext.
  return text.length > 1300 ? `${text.slice(0, 1300)}… (${text.length} chars total)` : text;
}

/**
 * The outbound request body as loggable text. Bodies here are JSON strings or
 * multipart uploads; headers are deliberately NOT represented — the bearer
 * token must never reach the logs table.
 */
function describeRequestBody(body: RequestInit['body'] | undefined): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return truncateForLog(body);
  if (body instanceof FormData) return '[multipart form data]';
  return '[non-text body]';
}

export class JiraApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public isAuthError: boolean = status === 401,
    /** Jira's per-field complaints, so a caller can retry without them. */
    public fieldErrors: Record<string, string> = {}
  ) {
    super(message);
    this.name = 'JiraApiError';
  }
}
