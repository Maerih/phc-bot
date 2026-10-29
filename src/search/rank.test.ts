import { describe, expect, it } from 'vitest';
import { normalizeOpportunity, type NormalizedOpportunity } from '../domain/normalize.js';
import { parseQuery } from './query.js';
import { applyFilters, rank, relevanceScore } from './rank.js';

const SOURCE = { slug: 'test', name: 'Test Source' };

function make(partial: {
  title: string;
  organization?: string;
  description?: string;
  tags?: string[];
  remote?: boolean | null;
  country?: string | null;
  deadline?: Date | null;
  datePosted?: Date | null;
}): NormalizedOpportunity {
  const normalized = normalizeOpportunity(
    {
      title: partial.title,
      organization: partial.organization ?? 'Some Organisation',
      description: partial.description ?? null,
      tags: partial.tags ?? [],
      remote: partial.remote ?? null,
      country: partial.country ?? null,
      deadline: partial.deadline ?? null,
      datePosted: partial.datePosted ?? null,
    },
    SOURCE,
  );
  if (!normalized) throw new Error('fixture failed to normalise');
  return normalized;
}

describe('relevanceScore', () => {
  it('scores a title phrase match highest', () => {
    const query = parseQuery('public health');
    expect(relevanceScore(make({ title: 'Public Health Officer' }), query)).toBe(1);
  });

  it('rejects results that match the query words only in unrelated contexts', () => {
    // The regression this guards: "public" from "Public Sector Consulting" plus
    // "health" from a benefits blurb used to rank as a public health job.
    const query = parseQuery('public health');
    const score = relevanceScore(
      make({
        title: 'Graduate Analyst Programme - Public Sector Consulting',
        description: 'We offer private health insurance and a pension.',
      }),
      query,
    );
    // Below the default quality gate of 0.25, so the search drops it.
    expect(score).toBeLessThan(0.25);
  });

  it('does not treat a substring as a word match', () => {
    // "health" must not match "Healthcare".
    const query = parseQuery('health');
    expect(relevanceScore(make({ title: 'Softwaretester Healthcare SaaS' }), query)).toBe(0);
  });

  it('accepts a phrase found in the body', () => {
    const query = parseQuery('public health');
    const score = relevanceScore(
      make({
        title: 'Research Associate',
        description: 'You will join our public health evaluation team in Nairobi.',
      }),
      query,
    );
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it('scores every result equally when no terms are given', () => {
    const query = parseQuery('');
    expect(relevanceScore(make({ title: 'Anything At All' }), query)).toBe(1);
  });

  it('ranks a title match above a tag match above a body match', () => {
    const query = parseQuery('epidemiology');
    const inTitle = relevanceScore(make({ title: 'Epidemiology Officer' }), query);
    const inTags = relevanceScore(make({ title: 'Field Officer', tags: ['Epidemiology'] }), query);
    const inBody = relevanceScore(
      make({ title: 'Field Officer', description: 'Supports epidemiology work.' }),
      query,
    );
    expect(inTitle).toBeGreaterThan(inTags);
    expect(inTags).toBeGreaterThan(inBody);
  });
});

describe('applyFilters', () => {
  const now = new Date('2026-10-04T00:00:00Z');

  it('drops opportunities whose deadline has passed', () => {
    const expired = make({ title: 'Closed Fellowship', deadline: new Date('2026-09-01T00:00:00Z') });
    expect(applyFilters([expired], parseQuery(''), now)).toHaveLength(0);
  });

  it('keeps opportunities with no stated deadline', () => {
    // Unknown is not evidence of expiry.
    const open = make({ title: 'Rolling Internship', deadline: null });
    expect(applyFilters([open], parseQuery(''), now)).toHaveLength(1);
  });

  it('treats an unknown remote flag as not remote for .jobs remote', () => {
    const unknown = make({ title: 'Analyst', remote: null });
    const known = make({ title: 'Analyst Two', remote: true });
    const result = applyFilters([unknown, known], parseQuery('remote'), now);
    expect(result.map((entry) => entry.title)).toEqual(['Analyst Two']);
  });

  it('requires a known posting date for a recency filter', () => {
    const undated = make({ title: 'Undated Role', datePosted: null });
    const fresh = make({ title: 'Fresh Role', datePosted: new Date('2026-10-03T12:00:00Z') });
    const result = applyFilters([undated, fresh], parseQuery('today'), now);
    expect(result.map((entry) => entry.title)).toEqual(['Fresh Role']);
  });

  it('filters by country', () => {
    const kenya = make({ title: 'Officer Kenya', country: 'KE' });
    const germany = make({ title: 'Officer Berlin', country: 'DE' });
    const result = applyFilters([kenya, germany], parseQuery('kenya'), now);
    expect(result.map((entry) => entry.country)).toEqual(['KE']);
  });

  it('filters by african region', () => {
    const kenya = make({ title: 'Officer A', country: 'KE' });
    const swiss = make({ title: 'Officer B', country: 'CH' });
    const unknown = make({ title: 'Officer C', country: null });
    const result = applyFilters([kenya, swiss, unknown], parseQuery('africa'), now);
    expect(result.map((entry) => entry.country)).toEqual(['KE']);
  });
});

describe('applyFilters — lenient mode for web-fallback results', () => {
  const now = new Date('2026-10-04T00:00:00Z');

  it('keeps a result with no country when a country was requested', () => {
    // Regression: the fallback found two real Kenyan scholarships and the
    // country filter discarded both, because a web page rarely states an ISO
    // code. A working feature looked broken.
    const unknownCountry = make({ title: 'KMTC Scholarship', country: null });
    expect(applyFilters([unknownCountry], parseQuery('kenya'), now)).toHaveLength(0);
    expect(
      applyFilters([unknownCountry], parseQuery('kenya'), now, { treatUnknownAsMatch: true }),
    ).toHaveLength(1);
  });

  it('keeps a result with no posting date when recency was requested', () => {
    // Fallback results never carry a posting date by design.
    const undated = make({ title: 'Fellowship', datePosted: null });
    expect(applyFilters([undated], parseQuery('today'), now)).toHaveLength(0);
    expect(
      applyFilters([undated], parseQuery('today'), now, { treatUnknownAsMatch: true }),
    ).toHaveLength(1);
  });

  it('still rejects a country that was stated and does not match', () => {
    // Leniency applies to unknowns only, never to a contradiction.
    const german = make({ title: 'Officer', country: 'DE' });
    expect(
      applyFilters([german], parseQuery('kenya'), now, { treatUnknownAsMatch: true }),
    ).toHaveLength(0);
  });

  it('still rejects an expired deadline even when lenient', () => {
    const expired = make({ title: 'Closed', deadline: new Date('2026-09-01T00:00:00Z') });
    expect(
      applyFilters([expired], parseQuery(''), now, { treatUnknownAsMatch: true }),
    ).toHaveLength(0);
  });

  it('still requires an explicit remote flag even when lenient', () => {
    const unknownRemote = make({ title: 'Analyst', remote: null });
    expect(
      applyFilters([unknownRemote], parseQuery('remote'), now, { treatUnknownAsMatch: true }),
    ).toHaveLength(0);
  });
});

describe('rank', () => {
  it('drops results below the relevance gate when terms are supplied', () => {
    const query = parseQuery('public health');
    const irrelevant = make({ title: 'Warehouse Picker' });
    expect(rank([irrelevant], { query })).toHaveLength(0);
  });

  it('keeps everything when no terms are supplied', () => {
    const query = parseQuery('');
    const anything = make({ title: 'Warehouse Picker' });
    expect(rank([anything], { query })).toHaveLength(1);
  });

  it('orders by descending score', () => {
    const query = parseQuery('epidemiology');
    const scored = rank(
      [
        make({ title: 'Officer', description: 'some epidemiology duties' }),
        make({ title: 'Epidemiology Lead' }),
      ],
      { query },
    );
    expect(scored[0]?.opportunity.title).toBe('Epidemiology Lead');
    expect(scored[0]!.score).toBeGreaterThan(scored[1]!.score);
  });

  it('prefers a sooner deadline among otherwise equal results', () => {
    const now = new Date('2026-10-04T00:00:00Z');
    const query = parseQuery('');
    const soon = make({ title: 'A', deadline: new Date('2026-10-14T00:00:00Z') });
    const distant = make({ title: 'B', deadline: new Date('2027-06-01T00:00:00Z') });
    const scored = rank([distant, soon], { query, now });
    expect(scored[0]?.opportunity.title).toBe('A');
  });
});
