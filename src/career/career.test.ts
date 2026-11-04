import { describe, expect, it } from 'vitest';
import { enforceProfileFacts, type CvContent } from './cv.js';
import { cleanProfile, cvReadiness, EMPTY_PROFILE, isConsent, mergeProfile } from './profile.js';

const profile = cleanProfile({
  fullName: 'Amina Wanjiru',
  email: 'amina@example.com',
  location: 'Kisumu',
  education: [{ institution: 'Maseno University', qualification: 'BSc', field: 'Public Health', end: '2023' }],
  experience: [{ role: 'Public Health Intern', organization: 'Kisumu County Department of Health', highlights: ['Supported household surveys for 120 households'] }],
  skills: ['KoboToolbox', 'Excel', 'DHIS2'],
});

const draft = (overrides: Partial<CvContent> = {}): CvContent => ({
  name: 'Someone Else',
  headline: 'Public health data officer',
  contact: ['made-up@example.com'],
  summary: 'Public health graduate with survey experience. Managed a budget of 5,000,000 shillings.',
  skills: [{ group: 'Data', items: ['KoboToolbox', 'Stata', 'Excel'] }],
  experience: [
    { role: 'Public Health Intern', organization: 'Kisumu County Department of Health', bullets: ['Surveyed 120 households', 'Trained 40 volunteers'] },
    { role: 'Data Manager', organization: 'WHO', bullets: ['Led national surveillance'] },
  ],
  education: [
    { qualification: 'BSc Public Health', institution: 'Maseno University' },
    { qualification: 'MPH', institution: 'Harvard University' },
  ],
  certifications: ['PMP'],
  projects: [],
  achievements: ['Won the national innovation prize'],
  languages: [],
  referees: [{ name: 'Invented Referee' }],
  keywords: [],
  ...overrides,
});

describe('enforceProfileFacts', () => {
  const cv = enforceProfileFacts(draft(), profile);

  it('takes name and contacts only from the profile', () => {
    expect(cv.name).toBe('Amina Wanjiru');
    expect(cv.contact).toEqual(['amina@example.com', 'Kisumu']);
  });
  it('drops employers, roles and institutions not in the profile', () => {
    expect(cv.experience.map((item) => item.organization)).toEqual(['Kisumu County Department of Health']);
    expect(cv.education.map((item) => item.institution)).toEqual(['Maseno University']);
  });
  it('drops bullets and sentences with numbers the profile does not contain', () => {
    expect(cv.experience[0]!.bullets).toEqual(['Surveyed 120 households']);
    expect(cv.summary).toBe('Public health graduate with survey experience.');
  });
  it('drops skills, certifications, achievements and referees that were invented', () => {
    expect(cv.skills[0]!.items).toEqual(['KoboToolbox', 'Excel']);
    expect(cv.certifications).toEqual([]);
    expect(cv.achievements).toEqual([]);
    expect(cv.referees).toEqual([]);
  });
});

describe('profile', () => {
  it('merges lists without duplicates and replaces single values', () => {
    const next = mergeProfile(profile, { skills: ['excel', 'SPSS'], location: 'Nairobi' });
    expect(next.skills).toEqual(['KoboToolbox', 'Excel', 'DHIS2', 'SPSS']);
    expect(next.location).toBe('Nairobi');
  });
  it('replaces a list when asked', () => {
    expect(mergeProfile(profile, { skills: ['R'] }, ['skills']).skills).toEqual(['R']);
  });
  it('keeps valid fields when part of the data is bad', () => {
    const cleaned = cleanProfile({ fullName: 'A B', email: 'not-an-email', skills: ['R'] });
    expect(cleaned.fullName).toBe('A B');
    expect(cleaned.email).toBeUndefined();
    expect(cleaned.skills).toEqual(['R']);
  });
  it('knows what a CV still needs', () => {
    expect(cvReadiness(EMPTY_PROFILE).ready).toBe(false);
    expect(cvReadiness(EMPTY_PROFILE).missing).toHaveLength(4);
    expect(cvReadiness(profile)).toMatchObject({ ready: true, missing: [] });
  });
  it('reads consent strictly', () => {
    for (const yes of ['YES', 'yes.', 'ok', 'Sawa', 'ndio!', 'I agree']) expect(isConsent(yes)).toBe(true);
    for (const no of ['no', 'yes but do not save my phone', 'maybe', 'yesterday']) expect(isConsent(no)).toBe(false);
  });
});

describe('cleanProfile salvage', () => {
  it('keeps an education entry with an unknown level or numeric years', () => {
    const cleaned = cleanProfile({ education: [{ institution: 'Maseno University', qualification: 'BSc Public Health', level: "bachelor's", start: 2019, end: 2023 }, { qualification: 'no institution' }] });
    expect(cleaned.education).toEqual([{ institution: 'Maseno University', qualification: 'BSc Public Health', start: '2019', end: '2023' }]);
  });
});

describe('mergeProfile identity', () => {
  it('updates the same job told twice instead of duplicating it', () => {
    const next = mergeProfile(profile, { experience: [{ role: 'Public health intern', organization: 'Kisumu County Department of Health', start: '2024-01', highlights: ['Cleaned survey data in KoboToolbox'] }] });
    expect(next.experience).toHaveLength(1);
    expect(next.experience[0]!.start).toBe('2024-01');
    expect(next.experience[0]!.highlights).toHaveLength(2);
  });
});
