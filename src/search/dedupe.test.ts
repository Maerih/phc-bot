import { describe, expect, it } from 'vitest';
import { normalizeOpportunity, type NormalizedOpportunity } from '../domain/normalize.js';
import { dedupe } from './dedupe.js';

function make(
  title: string,
  organization: string | null,
  sourceSlug: string,
  extra: { deadline?: Date | null; applicationUrl?: string | null } = {},
): NormalizedOpportunity {
  const result = normalizeOpportunity(
    {
      title,
      organization,
      deadline: extra.deadline ?? null,
      applicationUrl: extra.applicationUrl ?? null,
    },
    { slug: sourceSlug, name: sourceSlug },
  );
  if (!result) throw new Error('fixture failed to normalise');
  return result;
}

describe('dedupe', () => {
  it('collapses the same posting carried by two sources', () => {
    const records = [make('Health Data Analyst', 'WHO', 'a'), make('Health Data Analyst', 'WHO', 'b')];
    const { unique, removed } = dedupe(records);
    expect(unique).toHaveLength(1);
    expect(removed).toBe(1);
  });

  it('keeps the copy from the more trusted source', () => {
    const records = [make('Health Data Analyst', 'WHO', 'low'), make('Health Data Analyst', 'WHO', 'high')];
    const { unique } = dedupe(records, { trustBySlug: { low: 10, high: 90 } });
    expect(unique[0]?.sourceSlug).toBe('high');
  });

  it('breaks a trust tie on completeness', () => {
    const bare = make('Health Data Analyst', 'WHO', 'a');
    const rich = make('Health Data Analyst', 'WHO', 'b', {
      deadline: new Date('2027-01-01T00:00:00Z'),
      applicationUrl: 'https://example.org/apply',
    });
    const { unique } = dedupe([bare, rich], { trustBySlug: { a: 50, b: 50 } });
    expect(unique[0]?.applicationUrl).toBe('https://example.org/apply');
  });

  it('merges near-identical titles from the same organisation', () => {
    const records = [
      make('Health Data Analyst', 'WHO', 'a'),
      make('Health Data Analyst (Remote)', 'WHO', 'b'),
    ];
    expect(dedupe(records).unique).toHaveLength(1);
  });

  it('keeps the same title from different organisations', () => {
    const records = [make('Health Data Analyst', 'WHO', 'a'), make('Health Data Analyst', 'UNICEF', 'b')];
    expect(dedupe(records).unique).toHaveLength(2);
  });

  it('never merges when the organisation is unknown', () => {
    // Two employers can advertise the same title; hiding one would cost a
    // member a real opportunity.
    const records = [make('Health Data Analyst', null, 'a'), make('Health Data Analyst', null, 'b')];
    expect(dedupe(records).unique).toHaveLength(2);
  });

  it('handles an empty input', () => {
    expect(dedupe([]).unique).toHaveLength(0);
  });
});
