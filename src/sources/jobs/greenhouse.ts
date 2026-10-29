/**
 * Greenhouse job boards — first-party postings, straight from the employer.
 *
 * This is the highest-signal keyless source available to the platform, and it
 * works differently from the aggregators: instead of one upstream returning
 * everything, we name the organisations we care about and read their own
 * career boards. Postings are authoritative, carry real application deadlines
 * where the employer set one, and link directly to the employer's site — so
 * there is no aggregator in the middle to go stale or misreport.
 *
 * Organisations are configured, not hard-coded (`GREENHOUSE_BOARDS`), so an
 * administrator can add a health employer without touching this file. That is
 * the whole point of the connector architecture: one connector, N employers.
 *
 * API: https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 * No key, no registration, documented for public use.
 */
import { env } from '../../config/env.js';
import { safeDate } from '../../domain/normalize.js';
import type { RawOpportunity } from '../../domain/opportunity.js';
import { buildUrl, getJson } from '../common/http.js';
import type { ConnectorMeta, FetchContext, SourceConnector } from '../types.js';

const ENDPOINT = 'https://boards-api.greenhouse.io/v1/boards';

/** Boards are fetched in parallel, but not unboundedly. */
const MAX_CONCURRENT_BOARDS = 4;

interface GreenhouseNamed {
  name?: string;
}

interface GreenhouseJob {
  id?: number;
  title?: string;
  absolute_url?: string;
  company_name?: string;
  /** Entity-encoded HTML — the normaliser decodes and strips it. */
  content?: string;
  location?: GreenhouseNamed;
  offices?: GreenhouseNamed[];
  departments?: GreenhouseNamed[];
  first_published?: string;
  updated_at?: string;
  application_deadline?: string | null;
}

interface GreenhouseResponse {
  jobs?: GreenhouseJob[];
}

function buildMeta(): ConnectorMeta {
  const boards = env.GREENHOUSE_BOARDS;
  return {
    slug: 'greenhouse',
    name: 'Employer career boards',
    kind: 'API',
    homepageUrl: 'https://www.greenhouse.io',
    supplies: ['JOB', 'INTERNSHIP', 'FELLOWSHIP', 'VOLUNTEER'],
    minFetchIntervalMinutes: 180,
    // First-party employer postings: the organisation is publishing its own
    // vacancy, so this outranks every aggregator we carry.
    trustScore: 85,
    attributionRequired: false,
    unavailableReason:
      boards.length > 0
        ? null
        : 'GREENHOUSE_BOARDS is empty — add organisation board tokens to enable employer career boards',
  };
}

function names(entries: GreenhouseNamed[] | undefined): string[] {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => entry.name).filter((name): name is string => typeof name === 'string');
}

/** Fetch one organisation's board. Failures are contained to that board. */
async function fetchBoard(
  token: string,
  context: FetchContext,
): Promise<RawOpportunity[]> {
  const url = buildUrl(`${ENDPOINT}/${encodeURIComponent(token)}/jobs`, { content: 'true' });
  const payload = await getJson<GreenhouseResponse>(url, { signal: context.signal, attempts: 2 });
  const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];

  return jobs.flatMap((job): RawOpportunity[] => {
    const title = typeof job.title === 'string' ? job.title : '';
    if (title.length === 0) return [];

    // Departments are the employer's own categorisation ("Cardiovascular
    // Health", "Epidemiology") — a far better classification signal than
    // anything inferable from prose.
    const departments = names(job.departments);
    const offices = names(job.offices);
    const location = job.location?.name ?? offices[0] ?? null;

    return [
      {
        title,
        organization: job.company_name ?? token,
        description: job.content ?? null,
        location,
        // Not derived here: `resolveCountry` reads the location string during
        // normalisation and refuses to guess when several countries appear.
        country: null,
        // Greenhouse has no remote flag; "Remote - Kinshasa" shows up in the
        // title or location text, which the detector reads.
        remote: null,
        deadline: safeDate(job.application_deadline ?? null),
        datePosted: safeDate(job.first_published ?? job.updated_at ?? null),
        applicationUrl: job.absolute_url ?? null,
        sourceUrl: job.absolute_url ?? null,
        tags: [...departments, ...offices],
        skills: departments,
        compensation: null,
        externalId: job.id !== undefined ? `${token}:${job.id}` : null,
      },
    ];
  });
}

export const greenhouseConnector: SourceConnector = {
  meta: buildMeta(),

  async fetch(context: FetchContext): Promise<RawOpportunity[]> {
    const boards = env.GREENHOUSE_BOARDS;
    if (boards.length === 0) return [];

    const collected: RawOpportunity[] = [];

    // Chunked so a long board list cannot open dozens of sockets at once.
    for (let offset = 0; offset < boards.length; offset += MAX_CONCURRENT_BOARDS) {
      const chunk = boards.slice(offset, offset + MAX_CONCURRENT_BOARDS);
      const settled = await Promise.allSettled(chunk.map((token) => fetchBoard(token, context)));

      settled.forEach((result, index) => {
        const token = chunk[index];
        if (result.status === 'fulfilled') {
          collected.push(...result.value);
        } else {
          // One organisation renaming or closing its board must not cost us
          // every other employer's vacancies.
          context.log.warn(
            { board: token, err: String(result.reason) },
            'greenhouse board unavailable; continuing with the others',
          );
        }
      });
    }

    context.log.debug({ boards: boards.length, received: collected.length }, 'greenhouse responded');
    return collected;
  },
};
