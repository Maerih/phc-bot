import { describe, expect, it } from 'vitest';
import { extractPageFacts, toIsoDate } from './facts.js';
import { assessValidity, linkKey, sameOpportunity, sameOrganization, titleKey } from './identity.js';

describe('duplicates (cases from the live data)', () => {
  it('recognises one KEMRI job reposted by JobWeb Kenya', () => {
    expect(
      sameOpportunity(
        { title: 'Data Manager - Kisumu', organization: 'KEMRI', location: 'Kisumu, Kenya' },
        { title: 'Data Manager – Kisumu at Kenya Medical Research Institute (KEMRI)', organization: null, location: 'Kisumu' },
      ),
    ).not.toBeNull();
  });

  it('keeps the same title in two towns apart', () => {
    expect(
      sameOpportunity(
        { title: 'Data Manager - Kisumu', organization: 'KEMRI', location: 'Kisumu, Kenya' },
        { title: 'Data Manager - Busia', organization: 'KEMRI', location: 'Busia, Kenya' },
      ),
    ).toBeNull();
  });

  it('keeps the same role at two employers apart, even when only the title names them', () => {
    expect(
      sameOpportunity(
        { title: 'Health Records Officer at Westlands Specialist Hospital', organization: null },
        { title: 'Health Records Officer at Scion Hospital', organization: null },
      ),
    ).toBeNull();
  });

  it('matches on the application link or email', () => {
    expect(
      sameOpportunity(
        { title: 'Nutrition Intern', organization: 'AIC Kijabe Hospital', applyUrl: 'https://kijabehospital.org/careers/nutrition-intern?utm_source=x' },
        { title: 'Nutrition Intern Job at AIC Kijabe Hospital', organization: null, applyUrl: 'https://www.kijabehospital.org/careers/nutrition-intern/' },
      ),
    ).toBe('same application link');
    expect(
      sameOpportunity(
        { title: 'Community Health Officer', organization: 'Living Goods', emails: ['jobs@livinggoods.org'] },
        { title: 'Community Health Officer (Kisumu)', organization: 'Living Goods', emails: ['jobs@livinggoods.org'] },
      ),
    ).not.toBeNull();
  });

  it('does not merge different jobs that share a careers page', () => {
    expect(linkKey('https://amref.org/careers/')).toBe('');
    expect(
      sameOpportunity(
        { title: 'Research and Evidence Specialist', organization: 'Amref', applyUrl: 'https://amref.org/careers/' },
        { title: 'Finance Officer', organization: 'Amref', applyUrl: 'https://amref.org/careers/' },
      ),
    ).toBeNull();
  });

  it('understands acronyms and legal suffixes', () => {
    expect(sameOrganization('KEMRI', 'Kenya Medical Research Institute (KEMRI)')).toBe(true);
    expect(sameOrganization('Mount Kenya University', 'Mount Kenya University Limited')).toBe(true);
    expect(sameOrganization('Amref Health Africa', 'Living Goods')).toBe(false);
  });

  it('builds title keys without board decoration', () => {
    expect(titleKey('Research Assistant – Thika/Nairobi (Contract) VN01024')).toBe('research assistant thika nairobi vn01024');
    expect(titleKey('Nutrition Intern Job at AIC Kijabe Hospital')).toBe('nutrition intern');
  });
});

describe('validity', () => {
  const now = new Date('2026-11-04T09:00:00Z');
  const recent = new Date('2026-11-03T09:00:00Z');

  it('drops passed deadlines and keeps future ones', () => {
    expect(assessValidity({ deadline: '2026-11-03', posted: null, firstSeen: recent, seeded: false }, now)).toEqual({ ok: false, reason: 'expired' });
    expect(assessValidity({ deadline: '2026-11-04', posted: null, firstSeen: recent, seeded: true }, now)).toEqual({ ok: true });
  });

  it('drops old posts with no deadline (the weekly "N vacancies" posts)', () => {
    expect(assessValidity({ deadline: null, posted: '2026-09-15', firstSeen: recent, seeded: false }, now)).toEqual({ ok: false, reason: 'stale' });
    expect(assessValidity({ deadline: null, posted: '2026-10-20', firstSeen: recent, seeded: false }, now)).toEqual({ ok: true });
  });

  it('does not trust undated listings from a site’s first scan', () => {
    expect(assessValidity({ deadline: null, posted: null, firstSeen: recent, seeded: true }, now)).toEqual({ ok: false, reason: 'undated' });
    expect(assessValidity({ deadline: null, posted: null, firstSeen: recent, seeded: false }, now)).toEqual({ ok: true });
  });

  it('believes a page that says it is closed', () => {
    expect(assessValidity({ deadline: '2026-12-01', posted: null, firstSeen: recent, seeded: false, closed: true }, now)).toEqual({ ok: false, reason: 'closed' });
  });
});

describe('page facts', () => {
  it('reads schema.org JobPosting data', () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: 'Health Records &amp; Information Officer',
      datePosted: '2026-10-28',
      validThrough: '2026-11-20T23:59:00+03:00',
      hiringOrganization: { '@type': 'Organization', name: 'Medwin Medical Centre' },
      jobLocation: { '@type': 'Place', address: { addressLocality: 'Juja', addressCountry: 'KE' } },
      baseSalary: { currency: 'KES', value: { minValue: 40000, maxValue: 55000, unitText: 'MONTH' } },
      employmentType: 'FULL_TIME',
      applicationContact: { email: 'HR@medwin.co.ke' },
    })}</script>`;
    const facts = extractPageFacts(html, '');
    expect(facts).toMatchObject({
      title: 'Health Records & Information Officer',
      organization: 'Medwin Medical Centre',
      posted: '2026-10-28',
      deadline: '2026-11-20',
      location: 'Juja, KE',
      salary: 'KES 40,000 – 55,000 per month',
      emails: ['hr@medwin.co.ke'],
    });
  });

  it('falls back to the publication date and a deadline in the text', () => {
    const html = '<meta property="article:published_time" content="2026-10-30T08:00:00+03:00">';
    const facts = extractPageFacts(html, 'Interested candidates should send applications on or before 14th November 2026 to jobs@ngo.or.ke.');
    expect(facts).toMatchObject({ posted: '2026-10-30', deadline: '2026-11-14', emails: ['jobs@ngo.or.ke'] });
  });

  it('notices a closed advert', () => {
    expect(extractPageFacts('', 'Sorry, this job has expired.').closed).toBe(true);
  });

  it('reads the date formats Kenyan adverts use', () => {
    expect(toIsoDate('Friday, 20th November, 2026')).toBe('2026-11-20');
    expect(toIsoDate('November 20, 2026')).toBe('2026-11-20');
    expect(toIsoDate('20/11/2026')).toBe('2026-11-20');
    expect(toIsoDate('31/02/2026')).toBeNull();
  });
});
