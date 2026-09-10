import { headers } from 'next/headers';
import { getPublicBaseUrl } from '@renkei/settings';

/**
 * The deployment's public origin, so admin forms can show concrete
 * copy-pasteable callback and webhook URLs instead of "this deployment's
 * origin + …". Mirrors getOrigin's resolution order (lib/get-origin.ts):
 * PUBLIC_BASE_URL when declared, else the trusted reverse proxy's
 * X-Forwarded-* headers. Null when neither is available — the forms then
 * fall back to abstract phrasing.
 */
export async function resolvePublicOrigin(): Promise<string | null> {
  const configured = getPublicBaseUrl();
  if (configured) return configured;
  const requestHeaders = await headers();
  const proto = requestHeaders.get('x-forwarded-proto');
  const host = requestHeaders.get('x-forwarded-host');
  if (proto && host) return `${proto}://${host}`;
  return null;
}
