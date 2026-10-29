import { describe, expect, it } from 'vitest';
import { normalizeOpportunity, safeDate, safeUrl } from './normalize.js';

const SOURCE = { slug: 'test', name: 'Test Source' };

function normalize(raw: Parameters<typeof normalizeOpportunity>[0]) {
  return normalizeOpportunity(raw, SOURCE);
}

describe('safeUrl', () => {
  it('accepts http and https', () => {
    expect(safeUrl('https://example.org/jobs/1')).toBe('https://example.org/jobs/1');
    expect(safeUrl('http://example.org')).toBe('http://example.org/');
  });

  it('rejects non-web schemes', () => {
    // These would otherwise reach a member's phone as a tappable link.
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeUrl('file:///etc/passwd')).toBeNull();
  });

  it('rejects malformed and empty values', () => {
    expect(safeUrl('not a url')).toBeNull();
    expect(safeUrl('')).toBeNull();
    expect(safeUrl(null)).toBeNull();
  });
});

describe('safeDate', () => {
  it('parses ISO strings', () => {
    expect(safeDate('2026-10-04T00:00:00Z')?.getUTCFullYear()).toBe(2026);
  });

  it('rejects epoch placeholders and absurd years', () => {
    expect(safeDate('1970-01-01T00:00:00Z')).toBeNull();
    expect(safeDate('2999-01-01T00:00:00Z')).toBeNull();
  });

  it('rejects unparseable values', () => {
    expect(safeDate('soon')).toBeNull();
    expect(safeDate(null)).toBeNull();
    expect(safeDate('')).toBeNull();
  });
});

describe('normalizeOpportunity', () => {
  it('drops records with no title', () => {
    expect(normalize({ title: '' })).toBeNull();
    expect(normalize({ title: '   ' })).toBeNull();
  });

  it('leaves unknown fields null rather than inventing them', () => {
    const result = normalize({ title: 'Health Officer' });
    expect(result).not.toBeNull();
    expect(result?.deadline).toBeNull();
    expect(result?.compensation).toBeNull();
    expect(result?.country).toBeNull();
    // null, not false: the source said nothing about remote work.
    expect(result?.remote).toBeNull();
    expect(result?.educationLevel).toBe('UNKNOWN');
    expect(result?.experienceLevel).toBe('UNKNOWN');
  });

  it('starts every record as unpublished and unverified', () => {
    const result = normalize({ title: 'Health Officer' });
    expect(result?.status).toBe('DISCOVERED');
    expect(result?.verificationStatus).toBe('UNVERIFIED');
    expect(result?.verifiedAt).toBeNull();
  });

  it('strips html from descriptions', () => {
    const result = normalize({
      title: 'Analyst',
      description: '<p>Hello <strong>world</strong></p><script>alert(1)</script>',
    });
    expect(result?.description).toContain('Hello world');
    expect(result?.description).not.toContain('<');
    expect(result?.description).not.toContain('alert');
  });

  it('types a record from its title, not its description', () => {
    // Regression: a job ad mentioning conferences was typed as a CONFERENCE.
    const result = normalize({
      title: 'Monitoring and Evaluation Officer',
      description: 'You will present findings at international conferences and run training sessions.',
    });
    expect(result?.type).toBe('JOB');
  });

  it('types internships from the title', () => {
    expect(normalize({ title: 'Public Health Internship' })?.type).toBe('INTERNSHIP');
    expect(normalize({ title: 'Chevening Scholarship 2027' })?.type).toBe('SCHOLARSHIP');
    expect(normalize({ title: 'WHO Fellowship Programme' })?.type).toBe('FELLOWSHIP');
  });

  it('requires corroboration before taking a category from the body', () => {
    // Regression: one "mental health support" in a benefits list filed an
    // unrelated role under Mental Health.
    const result = normalize({
      title: 'Working Student Category Management',
      description: 'Benefits include mental health support and a gym membership.',
    });
    expect(result?.categories).not.toContain('MENTAL_HEALTH');
  });

  it('takes a category from the title directly', () => {
    const result = normalize({ title: 'Epidemiology Research Officer' });
    expect(result?.categories).toContain('EPIDEMIOLOGY');
  });

  it('resolves a single country but not an ambiguous list', () => {
    expect(normalize({ title: 'Officer', location: 'Nairobi' })?.country).toBe('KE');
    // A multi-region listing must not be pinned to one country.
    expect(normalize({ title: 'Officer', location: 'Kenya, Uganda, Tanzania' })?.country).toBeNull();
  });

  it('gives identical postings the same fingerprint across sources', () => {
    const first = normalizeOpportunity({ title: 'Health Data Analyst', organization: 'WHO' }, { slug: 'a', name: 'A' });
    const second = normalizeOpportunity({ title: 'health  data analyst', organization: 'who' }, { slug: 'b', name: 'B' });
    expect(first?.fingerprint).toBe(second?.fingerprint);
    // …but distinct upsert keys, so each source keeps its own row.
    expect(first?.externalKey).not.toBe(second?.externalKey);
  });

  it('falls back to the source url when no application url is given', () => {
    const result = normalize({ title: 'Officer', sourceUrl: 'https://example.org/job/1' });
    expect(result?.applicationUrl).toBe('https://example.org/job/1');
  });
});
