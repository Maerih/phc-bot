/**
 * Remotive — remote-work job board (public API, no key).
 *
 * Terms of use, which the connector is built to respect:
 *  - Listings must credit Remotive and link back to the Remotive URL.
 *    Enforced via `attributionRequired`, which the renderer honours.
 *  - "No need to request data too frequently… max 4 times a day."
 *    Enforced via a 6-hour `minFetchIntervalMinutes` plus the result cache.
 *  - Upstream data is already delayed 24h by Remotive, so `.jobs today`
 *    legitimately returns little from this source.
 *
 * Source: https://remotive.com/api-documentation
 */
import { safeDate } from '../../domain/normalize.js';
import type { RawOpportunity } from '../../domain/opportunity.js';
import { buildUrl, getJson } from '../common/http.js';
import type { ConnectorMeta, FetchContext, SourceConnector } from '../types.js';

const ENDPOINT = 'https://remotive.com/api/remote-jobs';

/** Shape of the fields this connector reads. Unlisted fields are ignored. */
interface RemotiveJob {
  id?: number;
  url?: string;
  title?: string;
  company_name?: string;
  category?: string;
  tags?: unknown;
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
}

interface RemotiveResponse {
  jobs?: RemotiveJob[];
}

const meta: ConnectorMeta = {
  slug: 'remotive',
  name: 'Remotive',
  kind: 'API',
  homepageUrl: 'https://remotive.com',
  supplies: ['JOB', 'INTERNSHIP'],
  minFetchIntervalMinutes: 360,
  trustScore: 60,
  attributionRequired: true,
  attributionText: 'via Remotive',
  unavailableReason: null,
};

/** Remotive encodes job type as snake_case; map only what we can be sure of. */
function typeFromJobType(jobType: string | undefined): 'INTERNSHIP' | undefined {
  return jobType === 'internship' ? 'INTERNSHIP' : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export const remotiveConnector: SourceConnector = {
  meta,

  async fetch({ query, signal, log }: FetchContext): Promise<RawOpportunity[]> {
    // Ask upstream for a generous slice and let the ranker narrow it: Remotive's
    // own `search` is loose, and we must not spend a second request to refine.
    const url = buildUrl(ENDPOINT, {
      search: query.terms || undefined,
      limit: 100,
    });

    const payload = await getJson<RemotiveResponse>(url, { signal, attempts: 2 });
    const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
    log.debug({ received: jobs.length }, 'remotive responded');

    return jobs.flatMap((job): RawOpportunity[] => {
      const title = typeof job.title === 'string' ? job.title : '';
      if (title.length === 0) return [];

      const tags = toStringArray(job.tags);
      const inferredType = typeFromJobType(job.job_type);

      return [
        {
          title,
          organization: job.company_name ?? null,
          description: job.description ?? null,
          ...(inferredType ? { type: inferredType } : {}),
          // Everything on Remotive is a remote role by definition of the board.
          remote: true,
          location: job.candidate_required_location ?? null,
          // Deliberately not set: a multi-region string like
          // "Europe, USA, UK" must not be collapsed into one country.
          country: null,
          deadline: null, // Remotive does not publish closing dates.
          applicationUrl: job.url ?? null,
          sourceUrl: job.url ?? null,
          datePosted: safeDate(job.publication_date),
          tags: job.category ? [job.category, ...tags] : tags,
          skills: tags,
          compensation: job.salary && job.salary.trim().length > 0 ? job.salary : null,
          externalId: job.id !== undefined ? String(job.id) : null,
        },
      ];
    });
  },
};
