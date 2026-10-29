/**
 * Arbeitnow — open job-board API (public, no key).
 *
 * Caveat worth knowing before relying on it: the feed is heavily
 * German/European and has no server-side search, so this connector pulls the
 * first pages and the search service filters and ranks locally. It earns its
 * place as a keyless breadth source, not as a public-health source — its
 * trust score is set accordingly.
 *
 * Source: https://documenter.getpostman.com/view/18545278/UVsEVUGQ
 */
import { safeDate } from '../../domain/normalize.js';
import type { RawOpportunity } from '../../domain/opportunity.js';
import { buildUrl, getJson } from '../common/http.js';
import type { ConnectorMeta, FetchContext, SourceConnector } from '../types.js';

const ENDPOINT = 'https://www.arbeitnow.com/api/job-board-api';

/**
 * One page only.
 *
 * Each page is ~325 records and several megabytes. Two pages consistently blew
 * the 12-second connector timeout, so the source failed on every single search
 * and contributed nothing. One page returns reliably, and for a low-trust
 * breadth source that is a far better trade than an ambitious fetch that never
 * completes.
 */
const MAX_PAGES = 1;

interface ArbeitnowJob {
  slug?: string;
  company_name?: string;
  title?: string;
  description?: string;
  remote?: boolean;
  url?: string;
  tags?: unknown;
  job_types?: unknown;
  location?: string;
  /** Unix seconds. */
  created_at?: number;
}

interface ArbeitnowResponse {
  data?: ArbeitnowJob[];
}

const meta: ConnectorMeta = {
  slug: 'arbeitnow',
  name: 'Arbeitnow',
  kind: 'API',
  homepageUrl: 'https://www.arbeitnow.com',
  supplies: ['JOB', 'INTERNSHIP'],
  minFetchIntervalMinutes: 180,
  trustScore: 40,
  attributionRequired: false,
  unavailableReason: null,
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export const arbeitnowConnector: SourceConnector = {
  meta,

  async fetch({ signal, log }: FetchContext): Promise<RawOpportunity[]> {
    const collected: ArbeitnowJob[] = [];

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const payload = await getJson<ArbeitnowResponse>(buildUrl(ENDPOINT, { page }), {
        signal,
        attempts: 2,
      });
      const batch = Array.isArray(payload.data) ? payload.data : [];
      collected.push(...batch);
      // A short page means we have reached the end of the feed.
      if (batch.length === 0) break;
    }

    log.debug({ received: collected.length }, 'arbeitnow responded');

    return collected.flatMap((job): RawOpportunity[] => {
      const title = typeof job.title === 'string' ? job.title : '';
      if (title.length === 0) return [];

      const tags = toStringArray(job.tags);
      const jobTypes = toStringArray(job.job_types);

      return [
        {
          title,
          organization: job.company_name ?? null,
          description: job.description ?? null,
          remote: typeof job.remote === 'boolean' ? job.remote : null,
          location: job.location ?? null,
          deadline: null, // not published by this source
          applicationUrl: job.url ?? null,
          sourceUrl: job.url ?? null,
          datePosted:
            typeof job.created_at === 'number' ? safeDate(new Date(job.created_at * 1000)) : null,
          tags: [...tags, ...jobTypes],
          skills: tags,
          compensation: null,
          externalId: job.slug ?? null,
        },
      ];
    });
  },
};
