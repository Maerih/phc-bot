import { describe, expect, it } from 'vitest';
import { parseJson, withoutTracking } from './ai.js';
import { formatDeadline, renderCard, renderWeeklyReport, weeklyReportCsv, weekendMessage, type OpportunityCard } from './card.js';
import { extractLinks, htmlToText, listingCandidates, siteKey } from './html.js';
import { isGenericTitle, isHealthish, isPublicHealth, keywordVerdict, typeFromTitle } from './relevance.js';
import { allowedBy, parseRobots } from './robots.js';
import { inDripWindow, isReportTime, localTime, nextDripDelayMs, weekStart, type LocalTime } from './schedule.js';
import { TRACKED_SITES } from './sites.js';

const at = (weekday: number, hour: number, minute = 0): LocalTime => ({ weekday, hour, minute, date: '2026-11-02' });

describe('schedule', () => {
  it('starts on Monday at 03:00, not before', () => {
    expect(inDripWindow(at(1, 2, 59))).toBe(false);
    expect(inDripWindow(at(1, 3, 0))).toBe(true);
  });

  it('runs day and night from Tuesday to Thursday', () => {
    for (const day of [2, 3, 4]) {
      expect(inDripWindow(at(day, 0))).toBe(true);
      expect(inDripWindow(at(day, 23, 59))).toBe(true);
    }
  });

  it('stops on Friday at 13:00', () => {
    expect(inDripWindow(at(5, 12, 59))).toBe(true);
    expect(inDripWindow(at(5, 13, 0))).toBe(false);
  });

  it('is silent all weekend', () => {
    for (const hour of [0, 9, 14, 23]) {
      expect(inDripWindow(at(6, hour))).toBe(false);
      expect(inDripWindow(at(7, hour))).toBe(false);
    }
  });

  it('reports on Friday from 14:00 only', () => {
    expect(isReportTime(at(5, 13, 59))).toBe(false);
    expect(isReportTime(at(5, 14, 0))).toBe(true);
    expect(isReportTime(at(4, 14, 0))).toBe(false);
    expect(isReportTime(at(6, 14, 0))).toBe(false);
  });

  it('spaces opportunities 10 to 15 minutes apart', () => {
    expect(nextDripDelayMs(() => 0)).toBe(10 * 60_000);
    expect(nextDripDelayMs(() => 1)).toBe(15 * 60_000);
  });

  it('reads the local time in Nairobi', () => {
    // 2026-11-06 is a Friday; 11:00 UTC is 14:00 in Nairobi.
    const local = localTime(new Date('2026-11-06T11:00:00Z'), 'Africa/Nairobi');
    expect(local).toMatchObject({ weekday: 5, hour: 14, minute: 0, date: '2026-11-06' });
    expect(weekStart(local)).toBe('2026-11-02');
  });
});

describe('html', () => {
  const page = `
    <nav><a href="/about">About us</a><a href="/category/jobs">All job categories here</a></nav>
    <a href="/jobs/public-health-officer-nairobi?utm_source=x">Public Health Officer – Nairobi County</a>
    <a href="https://employer.org/careers/123">Apply on the employer website</a>
    <a href="https://facebook.com/share?u=1">Share this job on Facebook now</a>
    <table><tr><td>VN01024 Research Assistant – Thika</td><td><a href="/Home/SingleJobView/VN01024">View</a></td></tr></table>
  `;

  it('keeps listings and drops navigation and sharing', () => {
    const titles = listingCandidates(page, 'https://jobs.example.co.ke/jobs').map((link) => link.text);
    expect(titles).toContain('Public Health Officer – Nairobi County');
    expect(titles.some((title) => /about|categories|facebook/i.test(title))).toBe(false);
  });

  it('takes the title from the table row for a "View" button', () => {
    const titles = listingCandidates(page, 'https://jobs.example.co.ke/jobs').map((link) => link.text);
    expect(titles).toContain('VN01024 Research Assistant – Thika');
  });

  it('marks links to other sites as external', () => {
    const employer = extractLinks(page, 'https://jobs.example.co.ke/jobs').find((link) => link.url.includes('employer.org'));
    expect(employer?.external).toBe(true);
  });

  it('treats subdomains of one organisation as the same site', () => {
    expect(siteKey('recruit.kmtc.ac.ke')).toBe(siteKey('www.kmtc.ac.ke'));
    expect(siteKey('jobs.unicef.org')).toBe('unicef.org');
  });

  it('turns a page into readable text without scripts', () => {
    const text = htmlToText('<body><script>alert(1)</script><h1>Nutritionist</h1><p>Salary &amp; benefits</p></body>');
    expect(text).toContain('Nutritionist');
    expect(text).toContain('Salary & benefits');
    expect(text).not.toContain('alert');
  });
});

describe('relevance', () => {
  it('recognises public-health roles', () => {
    for (const title of [
      'Community Health Promoter – Kisumu',
      'Health Records and Information Officer',
      'Occupational Health and Safety Officer',
      'Epidemiologist (Disease Surveillance)',
      'MPH Scholarship for African students',
      'WASH Programme Coordinator',
    ]) {
      expect(isPublicHealth(title), title).toBe(true);
    }
  });

  it('leaves unrelated roles alone', () => {
    expect(isHealthish('Senior Accountant at a logistics firm')).toBe(false);
    expect(keywordVerdict('Customer Service Representative', false)).toBe(false);
  });

  it('accepts listings on health sites that look like opportunities', () => {
    expect(keywordVerdict('Data Manager – Busia (contract)', true)).toBe(true);
  });

  it('rejects generic pages', () => {
    expect(isGenericTitle('Job Description')).toBe(true);
    expect(isGenericTitle('Attachment and Internship Information Sheet')).toBe(true);
    expect(keywordVerdict('Current Vacancies', true)).toBe(false);
  });

  it('names the kind of opportunity', () => {
    expect(typeFromTitle('Public Health Internship 2026', 'JOB')).toBe('INTERNSHIP');
    expect(typeFromTitle('Global Health Fellowship', 'JOB')).toBe('FELLOWSHIP');
    expect(typeFromTitle('Nutrition Research Grant', 'JOB')).toBe('GRANT');
  });
});

describe('robots.txt', () => {
  const rules = parseRobots(['User-agent: *', 'Disallow: /admin', 'Disallow: /jobs/private', 'Allow: /jobs/private/open', '', 'User-agent: SomeOtherBot', 'Disallow: /'].join('\n'));

  it('honours disallow rules for every robot', () => {
    expect(allowedBy(rules, '/admin/login')).toBe(false);
    expect(allowedBy(rules, '/jobs/123')).toBe(true);
  });

  it('lets the longer allow rule win', () => {
    expect(allowedBy(rules, '/jobs/private/open/1')).toBe(true);
    expect(allowedBy(rules, '/jobs/private/x')).toBe(false);
  });

  it('ignores rules aimed at other robots', () => {
    expect(allowedBy(rules, '/anything')).toBe(true);
  });
});

const card: OpportunityCard = {
  title: 'Community Health Officer',
  organization: 'Amref Health Africa',
  type: 'JOB',
  field: 'Community health',
  location: 'Kisumu, Kenya',
  salary: 'KES 120,000 per month',
  deadline: '2026-11-20',
  terms: 'Full-time, 2-year contract',
  requirements: 'BSc Public Health; 3 years’ experience',
  summary: 'Leads community health promoters across two sub-counties.',
  applyUrl: 'https://amref.org/careers/123',
  original: true,
  foundOn: 'Work Kenya',
};

describe('card', () => {
  it('shows every basic fact and the original link', () => {
    const text = renderCard(card, new Date('2026-11-03T08:00:00Z'));
    for (const piece of ['*Community Health Officer*', 'Amref Health Africa', 'Kisumu, Kenya', 'KES 120,000', '20 Nov 2026', 'Full-time', 'BSc Public Health', 'Apply:* https://amref.org/careers/123', 'Found on Work Kenya']) {
      expect(text).toContain(piece);
    }
  });

  it('says so when a salary or deadline is not given', () => {
    const text = renderCard({ ...card, salary: null, deadline: null, original: false });
    expect(text).toContain('*Salary:* Not stated');
    expect(text).toContain('*Deadline:* Not stated');
    expect(text).toContain('*Details:*');
  });

  it('counts down the last week before a deadline', () => {
    expect(formatDeadline('2026-11-05', new Date('2026-11-03T08:00:00Z'))).toContain('days left');
    expect(formatDeadline('2026-11-01', new Date('2026-11-03T08:00:00Z'))).toContain('closed');
  });

  it('builds a weekly report grouped by type, with a spreadsheet', () => {
    const cards = [card, { ...card, title: 'MPH Scholarship', type: 'SCHOLARSHIP' as const }];
    const messages = renderWeeklyReport(cards, 'Week of 2 Nov 2026');
    expect(messages[0]).toContain('*2* opportunities');
    expect(messages.join('\n')).toContain('Scholarship (1)');
    const csv = weeklyReportCsv(cards);
    expect(csv.split('\r\n')[0]).toContain('Position,Organisation');
    expect(csv).toContain('"KES 120,000 per month"');
    expect(weekendMessage()).toMatch(/Monday/);
  });

  it('splits a long report into phone-sized messages', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({ ...card, title: `Community Health Officer ${index}` }));
    const messages = renderWeeklyReport(many, 'Week of 2 Nov 2026');
    expect(messages.length).toBeGreaterThan(2);
    expect(messages.every((message) => message.length <= 4000)).toBe(true);
  });
});

describe('AI answers', () => {
  it('reads JSON wrapped in prose or code fences', () => {
    expect(parseJson<{ relevant: number[] }>('Sure:\n```json\n{"relevant":[0,2]}\n```')).toEqual({ relevant: [0, 2] });
    expect(parseJson('no json here')).toBeNull();
  });

  it('removes referral tracking from links', () => {
    expect(withoutTracking('https://recruit.kmtc.ac.ke/jobs?kpx=73&utm_source=Jobweb')).toBe('https://recruit.kmtc.ac.ke/jobs?kpx=73');
  });
});

describe('sites', () => {
  it('has unique slugs and valid addresses', () => {
    const slugs = TRACKED_SITES.map((site) => site.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const site of TRACKED_SITES) expect(() => new URL(site.url)).not.toThrow();
  });

  it('leaves out sites that forbid automated reading', () => {
    expect(TRACKED_SITES.some((site) => /linkedin|indeed|glassdoor|upwork|flexjobs/.test(site.url))).toBe(false);
  });
});
