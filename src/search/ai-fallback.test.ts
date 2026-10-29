import { describe, expect, it } from 'vitest';
import { buildFallbackPrompt, buildSearchString, extractJsonArray, toRawOpportunity } from './ai-fallback.js';
import { parseQuery } from './query.js';

describe('extractJsonArray', () => {
  it('parses a bare array', () => {
    expect(extractJsonArray('[{"title":"A"}]')).toHaveLength(1);
  });

  it('parses an array wrapped in a code fence', () => {
    // Models fence JSON often enough that strict parsing would throw away
    // otherwise good results.
    expect(extractJsonArray('```json\n[{"title":"A"}]\n```')).toHaveLength(1);
  });

  it('parses an array surrounded by prose', () => {
    expect(extractJsonArray('Here is what I found:\n[{"title":"A"}]\nHope that helps.')).toHaveLength(1);
  });

  it('returns empty for malformed json rather than throwing', () => {
    expect(extractJsonArray('[{"title": ')).toEqual([]);
    expect(extractJsonArray('not json at all')).toEqual([]);
    expect(extractJsonArray('')).toEqual([]);
  });

  it('returns empty when the model replies with an object', () => {
    expect(extractJsonArray('{"title":"A"}')).toEqual([]);
  });

  it('handles an explicitly empty result', () => {
    expect(extractJsonArray('[]')).toEqual([]);
  });
});

describe('toRawOpportunity', () => {
  const valid = {
    title: 'Public Health Officer',
    organization: 'Ministry of Health',
    location: 'Nairobi, Kenya',
    country: 'KE',
    remote: false,
    type: 'JOB',
    deadline: '2027-01-15',
    url: 'https://example.org/jobs/1',
    summary: 'Supports county health programmes.',
  };

  it('accepts a well-formed entry', () => {
    const result = toRawOpportunity(valid);
    expect(result?.title).toBe('Public Health Officer');
    expect(result?.country).toBe('KE');
    expect(result?.applicationUrl).toBe('https://example.org/jobs/1');
  });

  it('rejects an entry with no usable url', () => {
    // A lead a member cannot click through to verify is worse than no lead:
    // it looks actionable and is not.
    expect(toRawOpportunity({ ...valid, url: undefined })).toBeNull();
    expect(toRawOpportunity({ ...valid, url: 'not a url' })).toBeNull();
    expect(toRawOpportunity({ ...valid, url: 'javascript:alert(1)' })).toBeNull();
  });

  it('rejects an entry with no title', () => {
    expect(toRawOpportunity({ ...valid, title: '' })).toBeNull();
    expect(toRawOpportunity({ ...valid, title: undefined })).toBeNull();
  });

  it('rejects non-objects', () => {
    expect(toRawOpportunity(null)).toBeNull();
    expect(toRawOpportunity('a string')).toBeNull();
    expect(toRawOpportunity(42)).toBeNull();
  });

  it('ignores an invented opportunity type', () => {
    const result = toRawOpportunity({ ...valid, type: 'TOTALLY_MADE_UP' });
    // Falls through to classification rather than trusting the model's label.
    expect(result?.type).toBeUndefined();
  });

  it('ignores a malformed country code', () => {
    expect(toRawOpportunity({ ...valid, country: 'Kenya' })?.country).toBeNull();
    expect(toRawOpportunity({ ...valid, country: 123 })?.country).toBeNull();
  });

  it('keeps remote as null when the model did not say', () => {
    expect(toRawOpportunity({ ...valid, remote: undefined })?.remote).toBeNull();
    expect(toRawOpportunity({ ...valid, remote: 'maybe' })?.remote).toBeNull();
  });

  it('never carries a posting date', () => {
    // The model has no reliable posting date; guessing one would corrupt both
    // the recency filter and the ranking.
    expect(toRawOpportunity({ ...valid, datePosted: '2026-10-01' })?.datePosted).toBeNull();
  });
});

describe('buildFallbackPrompt', () => {
  const now = new Date('2026-10-04T00:00:00Z');

  it('includes the topic, locations and types', () => {
    const query = parseQuery('public health nairobi, kisumu internship');
    const prompt = buildFallbackPrompt(query, now);
    expect(prompt).toContain('public health');
    expect(prompt).toContain('nairobi, kisumu');
    expect(prompt).toContain('INTERNSHIP');
  });

  it('pins today so the model can exclude closed opportunities', () => {
    expect(buildFallbackPrompt(parseQuery('health'), now)).toContain('2026-10-04');
  });

  it('states the remote requirement when asked', () => {
    expect(buildFallbackPrompt(parseQuery('health remote'), now)).toMatch(/must be remote/i);
  });

  it('falls back to a sensible topic for an empty query', () => {
    expect(buildFallbackPrompt(parseQuery(''), now)).toContain('public health');
  });
});

describe('buildSearchString', () => {
  it('includes the topic, type and location', () => {
    const q = parseQuery('public health nairobi scholarship');
    const s = buildSearchString(q);
    expect(s).toContain('public health');
    expect(s).toContain('scholarship');
    expect(s).toContain('nairobi');
  });

  it('falls back to a broad opportunity search for an empty query', () => {
    const s = buildSearchString(parseQuery(''));
    expect(s).toContain('public health');
    expect(s).toMatch(/scholarships/);
  });

  it('marks remote when asked', () => {
    expect(buildSearchString(parseQuery('health remote'))).toContain('remote');
  });
});
