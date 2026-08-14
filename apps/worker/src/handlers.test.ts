/**
 * Event dispatch.
 *
 * A source may carry a fairness LANE after a colon — `knowledge:jira` — so the
 * queue can round-robin between providers that would otherwise share one FIFO.
 * Dispatch has to see through that, or every laned message lands with no
 * handler and dead-letters.
 */

import { registerHandler, handlerFor } from './handlers';

describe('fairness lanes on the source', () => {
  it('dispatches a lane to the handler registered for its base source', () => {
    // `knowledge:jira` and `knowledge:confluence` exist so the queue can
    // round-robin between them; dispatch must not care which lane arrived.
    const handler = jest.fn();
    registerHandler('knowledge', 'ingest.object', handler);

    expect(handlerFor({ source: 'knowledge:jira', type: 'ingest.object' })).toBe(handler);
    expect(handlerFor({ source: 'knowledge:confluence', type: 'ingest.object' })).toBe(handler);
    // And rows written before lanes existed still match exactly.
    expect(handlerFor({ source: 'knowledge', type: 'ingest.object' })).toBe(handler);
  });

  it('still refuses an unknown source', () => {
    expect(handlerFor({ source: 'nonsense:jira', type: 'ingest.object' })).toBeUndefined();
  });

  it('prefers an exact registration over the lane fallback', () => {
    const base = jest.fn();
    const exact = jest.fn();
    registerHandler('knowledge', 'ingest.email', base);
    registerHandler('knowledge:outlook', 'ingest.email', exact);
    expect(handlerFor({ source: 'knowledge:outlook', type: 'ingest.email' })).toBe(exact);
  });
});
