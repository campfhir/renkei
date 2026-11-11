/**
 * Code-project previews on a host of their own.
 *
 * A preview is a repository's or a model's code answering in a browser.
 * Served on the app's origin, its script runs where the app's session is
 * and can call the app's API as whoever opened it. With the organization's
 * `codePreviewHost` set (admin → Settings), previews are served on that
 * host instead — another origin, so nothing a preview runs can reach the
 * app's cookies or its API with them.
 *
 * The operator's reverse proxy does one thing: it forwards every request
 * for the preview host to `PREVIEW_HOST_PREFIX` on the app, path appended,
 * with the original host in `X-Forwarded-Host` (or `Host`). Everything
 * else is routed here, by the catch-all under that prefix
 * (app/api/code/preview-host/[[...path]]/route.ts). On the preview host:
 *
 *   /t/<token>/…                               a share link (the token is the secret)
 *   /p/<projectId>/<name>/app/…                a member's preview, first port
 *   /p/<projectId>/<name>/ports/<port>/…       … a named port
 *   /p/<projectId>/c/<chatId>/<name>/app/…     … of a chat's worktree
 *   /enter?ticket=…&to=…                       the sign-in handoff (below)
 *
 * The app's session cookie does not exist on the preview host, so a member
 * is known there by a cookie of the preview host's own, `renkei_preview`:
 * the subject and an expiry under an HMAC. It is handed over by the app:
 * a member's preview without it redirects to the app's
 * `/api/code/preview-enter` (the app's session is checked there), which
 * redirects back to `/enter` with a ticket that lives a minute and names
 * the subject; `/enter` sets the cookie and goes on to the preview. Project
 * access is checked on every request against that subject, as the app's
 * own routes check it. The cookie is HttpOnly and is neither forwarded to a
 * preview nor settable by one; previews on the one host can otherwise see
 * each other's cookies, which is accepted.
 *
 * This module is the pure half: the layout, the host test, and the signed
 * values over a key the caller passes in.
 */

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/** Where the operator's proxy forwards the preview host to, path appended. */
export const PREVIEW_HOST_PREFIX = '/api/code/preview-host';
/** The app-origin route that hands a signed-in member over to the preview host. */
export const PREVIEW_ENTER_PATH = '/api/code/preview-enter';
/** The preview host's own session cookie. */
export const PREVIEW_SESSION_COOKIE = 'renkei_preview';

export const PREVIEW_TICKET_TTL_MS = 60_000;
export const PREVIEW_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const HOST_PATTERN =
  /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?::\d{1,5})?$/;

/** A host name as the setting stores it (lower-cased, optional port), or why it is not one. */
export function parsePreviewHost(
  input: string,
  appOrigin: string | null
): { ok: true; host: string } | { ok: false; error: string } {
  const host = input.trim().toLowerCase();
  if (!host) return { ok: true, host: '' };
  if (!HOST_PATTERN.test(host)) {
    return {
      ok: false,
      error: 'The preview host is a host name such as preview.example.com: no scheme, no path.',
    };
  }
  // The same host as the app is no separation at all.
  const appHost = hostOfOrigin(appOrigin);
  if (appHost && appHost === host) {
    return {
      ok: false,
      error: 'The preview host must be a different host name from the app’s own address.',
    };
  }
  return { ok: true, host };
}

function hostOfOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The host a request arrived for: what the proxy says it was, else its own. */
export function requestHost(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  return (forwarded || headers.get('host') || '').toLowerCase();
}

export function previewHostBase(host: string): string {
  return `https://${host}`;
}

// ── layout ──────────────────────────────────────────────────────────────────

export interface MemberPreviewRef {
  projectId: string;
  chatId?: string | null;
  name: string;
  /** A named port; absent means the first port's `app/` address. */
  port?: string | null;
}

/** A member's preview as the preview host addresses it. */
export function hostMemberPath(ref: MemberPreviewRef): string {
  const chat = ref.chatId ? `/c/${ref.chatId}` : '';
  const tail = ref.port ? `ports/${ref.port}` : 'app';
  return `/p/${ref.projectId}${chat}/${ref.name}/${tail}/`;
}

/** A share link as the preview host addresses it. */
export function hostTokenPath(token: string): string {
  return `/t/${token}/`;
}

export type PreviewHostRoute =
  | { kind: 'enter' }
  | { kind: 'token'; token: string; prefix: string; rest: string[] }
  | {
      kind: 'member';
      projectId: string;
      chatId: string | null;
      name: string;
      port: string | null;
      prefix: string;
      rest: string[];
    };

/**
 * What a path on the preview host names, from its segments (already split
 * by the router); null for anything that is not one of the shapes above.
 * Only the shape is decided here: ids, names and tokens are validated by
 * the caller, which knows their rules.
 */
export function parsePreviewHostPath(segments: readonly string[]): PreviewHostRoute | null {
  const [head, ...tail] = segments;
  if (head === 'enter' && tail.length === 0) return { kind: 'enter' };
  if (head === 't') {
    const [token, ...rest] = tail;
    if (!token) return null;
    return { kind: 'token', token, prefix: hostTokenPath(token), rest };
  }
  if (head !== 'p') return null;
  const [projectId, ...afterProject] = tail;
  if (!projectId) return null;
  let chatId: string | null = null;
  let remaining = afterProject;
  if (remaining[0] === 'c') {
    chatId = remaining[1] ?? null;
    if (!chatId) return null;
    remaining = remaining.slice(2);
  }
  const [name, mode, ...afterMode] = remaining;
  if (!name) return null;
  if (mode === 'app') {
    return {
      kind: 'member',
      projectId,
      chatId,
      name,
      port: null,
      prefix: hostMemberPath({ projectId, chatId, name }),
      rest: afterMode,
    };
  }
  if (mode === 'ports') {
    const [port, ...rest] = afterMode;
    if (!port) return null;
    return {
      kind: 'member',
      projectId,
      chatId,
      name,
      port,
      prefix: hostMemberPath({ projectId, chatId, name, port }),
      rest,
    };
  }
  return null;
}

/**
 * A path on the preview host that `/enter` may send a browser on to: one of
 * the preview shapes, nothing with a scheme, a host, a backslash or control
 * characters in it. Null for anything else.
 */
export function safePreviewHostPath(candidate: string | null | undefined): string | null {
  if (!candidate || !candidate.startsWith('/')) return null;
  if (candidate.includes('\\') || /%0[9ad]|%5c/i.test(candidate)) return null;
  for (const char of candidate) if (char.charCodeAt(0) < 0x20) return null;
  let url: URL;
  try {
    url = new URL(candidate, 'http://x');
  } catch {
    return null;
  }
  if (url.origin !== 'http://x') return null;
  const segments = url.pathname.split('/').filter(Boolean);
  const route = parsePreviewHostPath(segments);
  if (!route || route.kind === 'enter') return null;
  return `${url.pathname}${url.search}`;
}

// ── signed values ───────────────────────────────────────────────────────────

/** The key previews' tickets and cookies are signed with, from the deployment's encryption key. */
export function previewSigningKey(tokenEncryptionKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', tokenEncryptionKey, Buffer.alloc(0), 'renkei-preview-host-v1', 32)
  );
}

type SignedKind = 'ticket' | 'session';

function sign(key: Buffer, kind: SignedKind, body: string): string {
  return createHmac('sha256', key).update(`${kind}\0${body}`).digest('base64url');
}

/** `<base64url subject>.<expiry ms>.<signature>`: the kind is in the signature, so one cannot stand in for the other. */
function seal(key: Buffer, kind: SignedKind, subject: string, expiresAt: number): string {
  const body = `${Buffer.from(subject, 'utf8').toString('base64url')}.${expiresAt}`;
  return `${body}.${sign(key, kind, body)}`;
}

function open(key: Buffer, kind: SignedKind, value: string, now: number): string | null {
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [subjectPart, expiryPart, signature] = parts;
  if (!subjectPart || !expiryPart || !signature) return null;
  const expected = Buffer.from(sign(key, kind, `${subjectPart}.${expiryPart}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const expiresAt = Number(expiryPart);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  const subject = Buffer.from(subjectPart, 'base64url').toString('utf8');
  return subject || null;
}

/** The minute-long value the app hands the preview host for a signed-in member. */
export function mintPreviewTicket(key: Buffer, subject: string, now: number): string {
  return seal(key, 'ticket', subject, now + PREVIEW_TICKET_TTL_MS);
}

export function openPreviewTicket(key: Buffer, ticket: string, now: number): string | null {
  return open(key, 'ticket', ticket, now);
}

/** The preview host's cookie value for a member. */
export function mintPreviewSession(key: Buffer, subject: string, now: number): string {
  return seal(key, 'session', subject, now + PREVIEW_SESSION_TTL_MS);
}

export function openPreviewSession(key: Buffer, cookie: string, now: number): string | null {
  return open(key, 'session', cookie, now);
}
