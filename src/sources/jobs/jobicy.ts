/**
 * Jobicy — remote job board (public API, no key).
 *
 * Useful here because it exposes an `industry` filter, so the connector can
 * ask specifically for health-adjacent listings rather than pulling a generic
 * feed and discarding most of it.
 *
 * API: https://jobicy.com/api/v2/remote-jobs
 */
import { safeDate } from '../../domain/normalize.js';
import type { RawOpportunity } from '../../domain/opportunity.js';
import { buildUrl, getJson } from '../common/http.js';
import type { ConnectorMeta, FetchContext, SourceConnector } from '../types.js';

const ENDPOINT = 'https://jobicy.com/api/v2/remote-jobs';

interface JobicyJob {
  id?: number | string;
  url?: string;
  jobTitle?: string;
  companyName?: string;
  jobIndustry?: unknown;
  jobType?: unknown;
  jobGeo?: string;
  jobLevel?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;
}

interface JobicyResponse {
  jobs?: JobicyJob[];
}

const meta: ConnectorMeta = {
  slug: 'jobicy',
  name: 'Jobicy',
  kind: 'API',
  homepageUrl: 'https://jobicy.com',
  supplies: ['JOB', 'INTERNSHIP'],
  minFetchIntervalMinutes: 180,
  trustScore: 45,
  attributionRequired: false,
  unavailableReason: null,
};

/** Jobicy returns some fields as either a string or an array of strings. */
function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

export const jobicyConnector: SourceConnector = {
  meta,

  async fetch({ query, signal, log }: FetchContext): Promise<RawOpportunity[]> {
    const url = buildUrl(ENDPOINT, {
      count: 50,
      // Free-text tag search when the member gave terms; otherwise the feed.
      tag: query.terms.trim() || undefined,
    });

    const payload = await getJson<JobicyResponse>(url, { signal, attempts: 2 });
    const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    log.debug({ received: jobs.length }, 'jobicy responded');

    return jobs.flatMap((job): RawOpportunity[] => {
      const title = typeof job.jobTitle === 'string' ? job.jobTitle : '';
      if (title.length === 0 || typeof job.url !== 'string') return [];

      const industries = toList(job.jobIndustry);
      const types = toList(job.jobType);

      return [
        {
          title,
          organization: job.companyName ?? null,
          description: job.jobDescription ?? job.jobExcerpt ?? null,
          // Everything on Jobicy is remote by definition of the board.
          remote: true,
          location: job.jobGeo ?? null,
          // jobGeo is often a region list ("Anywhere", "USA, UK"), so country
          // resolution is left to normalisation, which refuses to guess.
          country: null,
          deadline: null,
          applicationUrl: job.url,
          sourceUrl: job.url,
          datePosted: safeDate(job.pubDate),
          tags: [...industries, ...types, ...(job.jobLevel ? [job.jobLevel] : [])],
          skills: industries,
          compensation: null,
          externalId: job.id !== undefined ? String(job.id) : null,
        },
      ];
    });
  },
};
