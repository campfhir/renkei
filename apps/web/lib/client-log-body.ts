/**
 * The shape a browser log line travels in, between `lib/client-logger.ts`
 * and `app/api/logs/client`. Everything in it is the browser's word, so the
 * parser bounds every field and keeps attributes to flat scalars: a log
 * line, not a place to store documents.
 */

import { isRecord } from '@renkei/guards';

export type ClientLogLevel = 'error' | 'warn' | 'info';

export interface ClientLogBody {
  level: ClientLogLevel;
  /** Already rendered by the browser: braces in it are text, not placeholders. */
  message: string;
  /** The area of the UI (chat/ocr, preferences, …); the route prefixes `client/`. */
  component: string;
  /** The page's path when it happened, no query string. */
  page?: string;
  stack?: string;
  attrs: Record<string, string | number | boolean>;
}

const MAX_MESSAGE = 2_000;
const MAX_STACK = 8_000;
const MAX_ATTRS = 30;
const MAX_ATTR_VALUE = 2_000;
/** Names the server stamps itself, never taken from the browser. */
const RESERVED = new Set([
  'component',
  'subject',
  'accountId',
  'userId',
  'displayName',
  'page',
  'stack',
]);

function bounded(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, max) : undefined;
}

export function parseClientLogBody(raw: unknown): ClientLogBody | null {
  if (!isRecord(raw)) return null;
  const level =
    raw.level === 'error' || raw.level === 'warn' || raw.level === 'info' ? raw.level : null;
  // The message is logged as the template, so its braces are escaped out of it.
  const message = bounded(raw.message, MAX_MESSAGE)?.replace(/[{}]/g, '');
  const component = bounded(raw.component, 80);
  if (!level || !message || !component || !/^[a-z0-9][a-z0-9/_-]*$/i.test(component)) return null;

  const attrs: Record<string, string | number | boolean> = {};
  if (isRecord(raw.attrs)) {
    for (const [key, value] of Object.entries(raw.attrs).slice(0, MAX_ATTRS)) {
      if (RESERVED.has(key) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
      if (typeof value === 'string') attrs[key] = value.slice(0, MAX_ATTR_VALUE);
      else if (typeof value === 'number' && Number.isFinite(value)) attrs[key] = value;
      else if (typeof value === 'boolean') attrs[key] = value;
    }
  }
  const page = bounded(raw.page, 500)?.split('?')[0];
  const stack = bounded(raw.stack, MAX_STACK);
  return {
    level,
    message,
    component,
    attrs,
    ...(page ? { page } : {}),
    ...(stack ? { stack } : {}),
  };
}
