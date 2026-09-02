import { relevanceOf } from './relevance';

describe('relevanceOf', () => {
  it('uses the fixed bands when no cutoff is configured', () => {
    expect(relevanceOf(0.1)).toBe('strong');
    expect(relevanceOf(0.3)).toBe('good');
    expect(relevanceOf(0.5)).toBe('possible');
    expect(relevanceOf(0.7)).toBe('weak');
    expect(relevanceOf(0.7, null)).toBe('weak');
  });

  it('scales the bands to the configured cutoff', () => {
    // With text-embedding-3 a good match sits around 0.6; a cutoff of 0.8
    // reads it as good rather than weak.
    expect(relevanceOf(0.3, 0.8)).toBe('strong');
    expect(relevanceOf(0.55, 0.8)).toBe('good');
    expect(relevanceOf(0.75, 0.8)).toBe('possible');
    expect(relevanceOf(0.85, 0.8)).toBe('weak');
  });

  it('treats a non-finite distance as weak', () => {
    expect(relevanceOf(Number.NaN)).toBe('weak');
    expect(relevanceOf(Number.POSITIVE_INFINITY, 0.5)).toBe('weak');
  });
});
