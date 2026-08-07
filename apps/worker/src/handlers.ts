/**
 * Event-handler registry.
 *
 * Handlers register per `${source}/${type}`; the pipeline stages of RENKEI.md
 * (classify → enrich → decide) will live behind these. An event with no
 * handler is a producer/consumer version mismatch — it fails and follows the
 * normal retry path, so a handler deployed shortly after its producer still
 * picks the event up.
 */

import type { ClaimedEvent } from './queue';

export type EventHandler = (event: ClaimedEvent) => Promise<void>;

const handlers = new Map<string, EventHandler>();

export function registerHandler(source: string, type: string, handler: EventHandler): void {
  handlers.set(`${source}/${type}`, handler);
}

export function handlerFor(event: Pick<ClaimedEvent, 'source' | 'type'>): EventHandler | undefined {
  return handlers.get(`${event.source}/${event.type}`);
}
