import { describe, expect, it } from 'vitest';
import { parseQuery } from './query.js';

describe('parseQuery', () => {
  it('keeps unrecognised words as search terms', () => {
    const query = parseQuery('epidemiology');
    expect(query.terms).toBe('epidemiology');
    expect(query.types).toEqual([]);
    expect(query.location).toBeNull();
  });

  it('extracts a location and removes it from the search terms', () => {
    const query = parseQuery('nairobi');
    expect(query.location).toBe('nairobi');
    expect(query.countries).toEqual(['KE']);
    // The location must not also be searched as free text, or every result
    // would need the literal word "nairobi" in its title.
    expect(query.terms).toBe('');
  });

  it('extracts an opportunity type', () => {
    const query = parseQuery('internship');
    expect(query.types).toEqual(['INTERNSHIP']);
    expect(query.terms).toBe('');
  });

  it('combines keyword, location, type and recency filters', () => {
    const query = parseQuery('epidemiology nairobi internship today');
    expect(query.terms).toBe('epidemiology');
    expect(query.types).toEqual(['INTERNSHIP']);
    expect(query.countries).toEqual(['KE']);
    expect(query.postedWithinDays).toBe(1);
  });

  it('detects remote requests', () => {
    expect(parseQuery('remote').remoteOnly).toBe(true);
    expect(parseQuery('work from home').remoteOnly).toBe(true);
    expect(parseQuery('nairobi').remoteOnly).toBe(false);
  });

  it('maps "this week" to a seven day window', () => {
    expect(parseQuery('this week').postedWithinDays).toBe(7);
  });

  it('keeps the tightest recency window when several are given', () => {
    expect(parseQuery('today this week').postedWithinDays).toBe(1);
  });

  it('accepts several locations in one query', () => {
    // ".job public health nairobi, kisumu" — both are Kenyan cities, so the
    // country list collapses to one entry while both terms are kept.
    const query = parseQuery('public health nairobi, kisumu');
    expect(query.terms).toBe('public health');
    expect(query.countries).toEqual(['KE']);
    expect(query.locationTerms).toEqual(['nairobi', 'kisumu']);
  });

  it('keeps every country when locations span more than one', () => {
    // Regression: resolving the joined string returned nothing as soon as two
    // countries were named, silently dropping the location filter entirely.
    const query = parseQuery('nairobi, kampala');
    expect(query.countries.sort()).toEqual(['KE', 'UG']);
  });

  it('recognises africa as a region rather than a country', () => {
    const query = parseQuery('africa');
    expect(query.region).toBe('africa');
    expect(query.countries).toEqual([]);
  });

  it('honours a forced type over one detected in the text', () => {
    // `.scholarships kenya` — the command decides the type, so "kenya" is a
    // location and "job" in the text must not override SCHOLARSHIP.
    const query = parseQuery('kenya job', { forcedTypes: ['SCHOLARSHIP'] });
    expect(query.types).toEqual(['SCHOLARSHIP']);
    expect(query.countries).toEqual(['KE']);
  });

  it('reads entry-level as an experience filter', () => {
    expect(parseQuery('entry-level').experienceLevel).toBe('ENTRY');
    expect(parseQuery('graduate').experienceLevel).toBe('GRADUATE');
  });

  it('handles empty input without throwing', () => {
    const query = parseQuery('');
    expect(query.terms).toBe('');
    expect(query.types).toEqual([]);
  });
});
