/**
 * How long the packages that cache what they read of the organization's
 * configuration — its settings (@renkei/settings), its connector configs
 * (@renkei/connector-config), its model roster (@renkei/agent-llm) — serve
 * a read from memory before asking the store again.
 *
 * Each names its own default (a minute). RENKEI_CONFIG_CACHE_TTL_MS
 * overrides all of them with a number of milliseconds: the browser suite
 * sets 0, so a switch a spec flips shows at once in every server bundle.
 * Anything else (unset, empty, negative, not a number) keeps the default.
 * Read on each use, so a test can set it.
 */
export function configCacheTtlMs(defaultMs: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RENKEI_CONFIG_CACHE_TTL_MS?.trim();
  if (!raw) return defaultMs;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : defaultMs;
}
