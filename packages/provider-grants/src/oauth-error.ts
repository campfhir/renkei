/**
 * What a failed token call said, for the refresh error's message — the
 * orchestrator logs it (refresh.ts). The OAuth `error` code and its
 * description only: the request's secrets never appear in either.
 */

export function oauthErrorSuffix(record: Record<string, unknown>): string {
  const code =
    typeof record.error === 'string'
      ? record.error
      : typeof record.reason === 'string'
        ? record.reason
        : '';
  const description =
    typeof record.error_description === 'string'
      ? record.error_description
      : typeof record.message === 'string'
        ? record.message
        : '';
  const detail = [code, description].filter(Boolean).join(' — ').slice(0, 300);
  return detail ? `: ${detail}` : '';
}

export function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
