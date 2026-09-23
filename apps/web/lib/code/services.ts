/**
 * A code project's services as its pages see them: what is running
 * beside the checkout (the worker's rows, checked against the engine as
 * they are listed), which images the organization allows (patterns
 * only — never a registry credential), and the shape of a start asked
 * for from the Services page. The payload takes the container's
 * variables and the exports as text — `KEY=value` a line, as a `.env`
 * reads — and turns them into the records the worker takes, naming any
 * line that was not a variable rather than dropping it.
 */

import {
  SERVICE_ENV_MAX,
  SERVICE_EXPORT_MAX,
  parseDotenv,
  validateServiceName,
} from '@renkei/connector-sandbox';
import type { WireImageRule, WireService } from '@renkei/sandbox-client';

export interface ServicesView {
  /** The deployment offers services at all (SANDBOX_SERVICES_ENABLED on both sides). */
  enabled: boolean;
  services: WireService[];
  /** The organization's allow-list, as patterns; empty means nothing can be started. */
  allowed: string[];
}

export interface ServicesSummary {
  enabled: boolean;
  running: number;
  /** Every service by name, running or not, for the card's one line. */
  names: string[];
  allowedCount: number;
}

export function summarizeServices(view: ServicesView): ServicesSummary {
  return {
    enabled: view.enabled,
    running: view.services.filter((service) => service.status === 'running').length,
    names: view.services.map((service) => service.name),
    allowedCount: view.allowed.length,
  };
}

export function allowedPatterns(rules: WireImageRule[]): string[] {
  return rules.map((rule) => rule.pattern).sort();
}

export interface ServiceStartInput {
  name: string;
  image: string;
  env: Record<string, string>;
  exports: Record<string, string>;
}

/** A start from the page: name, image, and the two text boxes. */
export function parseServiceStartPayload(body: unknown): ServiceStartInput | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'Malformed payload' };
  }
  const record: { name?: unknown; image?: unknown; env?: unknown; exports?: unknown } = body;
  const name = validateServiceName(record.name);
  if (!name.ok) return { error: name.message };
  const image = typeof record.image === 'string' ? record.image.trim() : '';
  if (!image)
    return { error: 'An image is required — postgres:16, redis:7, or one from your registry.' };
  const env = textRecord(record.env, 'env', SERVICE_ENV_MAX);
  if ('error' in env) return env;
  const exported = textRecord(record.exports, 'exports', SERVICE_EXPORT_MAX);
  if ('error' in exported) return exported;
  return { name: name.name, image, env: env.values, exports: exported.values };
}

function textRecord(
  value: unknown,
  what: 'env' | 'exports',
  max: number
): { values: Record<string, string> } | { error: string } {
  if (value === undefined || value === null || value === '') return { values: {} };
  if (typeof value !== 'string') return { error: `${what} is text, KEY=value a line.` };
  const parsed = parseDotenv(value);
  if (parsed.problems.length) {
    return {
      error: `Not read as ${what === 'env' ? 'variables' : 'exports'}: ${parsed.problems.join('; ')}.`,
    };
  }
  if (Object.keys(parsed.values).length > max) {
    return { error: `At most ${max} ${what === 'env' ? 'variables' : 'exports'}.` };
  }
  return { values: parsed.values };
}
