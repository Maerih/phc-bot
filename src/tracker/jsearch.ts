/**
 * JSearch (on RapidAPI): job searches across the big job indexes, which
 * include LinkedIn's postings.
 *
 * LinkedIn itself offers no job-search API to the public — its official API
 * only lets approved partners post jobs — and scraping LinkedIn breaks its
 * terms. JSearch is the lawful route to the same postings.
 *
 * The free plan allows roughly 200 requests a month, so the tracker runs a
 * few public-health searches once a day, rotating through the topics below.
 *
 * Docs: https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
 */
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import type { OpportunityCard } from './card.js';
import { htmlToText } from './html.js';
import { typeFromTitle } from './relevance.js';

const log = logger.child({ component: 'jsearch' });

const ENDPOINT = 'https://jsearch.p.rapidapi.com/search';
const HOST = 'jsearch.p.rapidapi.com';

/** Public-health searches, run a few per day in rotation. */
export const JSEARCH_TOPICS = [
  'public health',
  'community health',
  'health records and information officer',
  'epidemiologist',
  'nutritionist',
  'monitoring and evaluation health programme',
  'occupational health and safety officer',
  'WASH officer',
] as const;

export const SEARCHES_PER_DAY = 4;

interface JSearchJob {
  job_id?: string;
  job_title?: string;
  employer_name?: string | null;
  job_publisher?: string | null;
  job_employment_type?: string | null;
  job_apply_link?: string | null;
  job_apply_is_direct?: boolean | null;
  job_description?: string | null;
  job_city?: string | null;
  job_state?: string | null;
  job_country?: string | null;
  job_is_remote?: boolean | null;
  job_offer_expiration_datetime_utc?: string | null;
  job_posted_at_datetime_utc?: string | null;
  job_min_salary?: number | null;
  job_max_salary?: number | null;
  job_salary_currency?: string | null;
  job_salary_period?: string | null;
}

export interface JSearchHit {
  url: string;
  label: string;
  card: OpportunityCard;
}

export function jsearchConfigured(): boolean {
  return env.JSEARCH_API_KEY.trim().length > 0;
}

/** Which topics to search today: the next SEARCHES_PER_DAY, wrapping round. */
export function topicsForDay(dayNumber: number): string[] {
  const start = (dayNumber * SEARCHES_PER_DAY) % JSEARCH_TOPICS.length;
  return Array.from({ length: SEARCHES_PER_DAY }, (_, index) => JSEARCH_TOPICS[(start + index) % JSEARCH_TOPICS.length] as string);
}

function salary(job: JSearchJob): string | null {
  const { job_min_salary: min, job_max_salary: max, job_salary_currency: currency, job_salary_period: period } = job;
  if (!min && !max) return null;
  const amount = (value: number): string => value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const range = min && max && min !== max ? `${amount(min)} – ${amount(max)}` : amount((min ?? max) as number);
  return [currency, range, period ? `per ${period.toLowerCase()}` : null].filter(Boolean).join(' ');
}

export function toHit(job: JSearchJob): JSearchHit | null {
  const title = job.job_title?.trim();
  const url = job.job_apply_link?.trim();
  if (!title || !url) return null;
  const description = htmlToText(job.job_description ?? '', 2000).replace(/\s+/g, ' ').trim();
  const location = job.job_is_remote
    ? 'Remote'
    : [job.job_city, job.job_state, job.job_country === 'KE' ? 'Kenya' : job.job_country].filter(Boolean).join(', ') || null;
  const expires = job.job_offer_expiration_datetime_utc?.slice(0, 10) ?? null;
  const card: OpportunityCard = {
    title,
    organization: job.employer_name?.trim() || null,
    type: typeFromTitle(title, 'JOB'),
    field: null,
    location,
    salary: salary(job),
    deadline: expires && /^\d{4}-\d{2}-\d{2}$/.test(expires) ? expires : null,
    terms: job.job_employment_type ? job.job_employment_type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()) : null,
    requirements: null,
    summary: description ? `${description.slice(0, 300).replace(/\s\S*$/, '')}…` : null,
    applyUrl: url,
    original: job.job_apply_is_direct === true,
    foundOn: job.job_publisher ? `${job.job_publisher} (via JSearch)` : 'JSearch',
    posted: job.job_posted_at_datetime_utc?.slice(0, 10) ?? null,
  };
  return { url, label: `${title} — ${card.organization ?? ''}`, card };
}

/** One public-health search for Kenya, posted in the last week. */
export async function searchKenya(topic: string): Promise<JSearchHit[]> {
  const url = `${ENDPOINT}?${new URLSearchParams({
    query: `${topic} in Kenya`,
    country: 'ke',
    date_posted: 'week',
    page: '1',
    num_pages: '1',
  }).toString()}`;
  const response = await fetch(url, {
    headers: { 'X-RapidAPI-Key': env.JSEARCH_API_KEY.trim(), 'X-RapidAPI-Host': HOST },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    log.warn({ status: response.status, topic }, 'JSearch request failed');
    return [];
  }
  const payload = (await response.json().catch(() => ({}))) as { data?: JSearchJob[] };
  return (payload.data ?? []).flatMap((job) => {
    const hit = toHit(job);
    return hit ? [hit] : [];
  });
}
