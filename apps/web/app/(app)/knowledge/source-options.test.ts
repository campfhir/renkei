/**
 * The filter chips and the sources the search actually accepts, kept in
 * step.
 *
 * SharePoint content was indexed, searchable, and labelled on its own result
 * cards — but had no chip, because this list is written by hand while the
 * backend's vocabulary lives elsewhere. Nothing failed; the filter was
 * simply absent, which is the kind of gap only a person notices, and only if
 * they happen to look.
 */

import { KNOWLEDGE_SOURCE_NAMES } from '@/lib/mcp-tools/knowledge';
import { SOURCE_OPTIONS } from './source-options';

describe('knowledge source chips', () => {
  it('offers every source the search accepts', () => {
    const offered = new Set(SOURCE_OPTIONS.map((option) => option.id));
    const missing = KNOWLEDGE_SOURCE_NAMES.filter((name) => !offered.has(name));
    expect(missing).toEqual([]);
  });

  it('offers nothing the search would silently ignore', () => {
    const accepted = new Set(KNOWLEDGE_SOURCE_NAMES);
    const unknown = SOURCE_OPTIONS.filter((option) => !accepted.has(option.id));
    expect(unknown).toEqual([]);
  });

  it('gives every chip a label a person would recognise', () => {
    for (const option of SOURCE_OPTIONS) {
      expect(option.label.trim().length).toBeGreaterThan(0);
      // The id is the wire token; a chip showing it has not been named.
      expect(option.label).not.toBe(option.id);
    }
  });
});
