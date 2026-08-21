/**
 * Event-handler registry.
 *
 * Handlers register per `${source}/${type}`; the pipeline stages of RENKEI.md
 * (classify → enrich → decide) will live behind these. An event with no
 * handler is a producer/consumer version mismatch — it fails and follows the
 * normal retry path, so a handler deployed shortly after its producer still
 * picks the event up.
 */

import type { HandlerResolution } from '@renkei/worker-loop';
import type { ClaimedEvent } from './queue';

export type EventHandler = (event: ClaimedEvent) => Promise<HandlerResolution>;

const handlers = new Map<string, EventHandler>();

export function registerHandler(source: string, type: string, handler: EventHandler): void {
  handlers.set(`${source}/${type}`, handler);
}

export function handlerFor(event: Pick<ClaimedEvent, 'source' | 'type'>): EventHandler | undefined {
  const exact = handlers.get(`${event.source}/${event.type}`);
  if (exact) return exact;
  // A source may carry a fairness LANE after a colon — `knowledge:jira` — so
  // the queue can round-robin between providers that would otherwise share
  // one FIFO. Dispatch does not care which lane a message arrived on, so it
  // falls back to the base source. Handlers stay registered once, and rows
  // written before lanes existed still match exactly.
  const colon = event.source.indexOf(':');
  return colon > 0 ? handlers.get(`${event.source.slice(0, colon)}/${event.type}`) : undefined;
}
