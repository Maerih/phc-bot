/**
 * RemoteOK — remote job board (public API, no key).
 *
 * Two quirks the connector has to handle:
 *  - the first element of the response is a legal/attribution notice, not a
 *    job, so it is skipped by position
 *  - their terms require linking back to the listing, which is why
 *    `attributionRequired` is set and the renderer credits them
 *
 * API: https://remoteok.com/api
 */
import { safeDate } from '../../domain/normalize.js';
import type { RawOpportunity } from '../../domain/opportunity.js';
import { getJson } from '../common/http.js';
import type { ConnectorMeta, FetchContext, SourceConnector } from '../types.js';

const ENDPOINT = 'https://remoteok.com/api';

interface RemoteOkEntry {
  slug?: string;
  id?: string | number;
  epoch?: number;
  date?: string;
  company?: string;
  position?: string;
  tags?: unknown;
  description?: string;
  location?: string;
  salary_min?: number;
  salary_max?: number;
  apply_url?: string;
  url?: string;
  /** Present only on the leading legal notice element. */
  legal?: string;
}

const meta: ConnectorMeta = {
  slug: 'remoteok',
  name: 'RemoteOK',
  kind: 'API',
  homepageUrl: 'https://remoteok.com',
  supplies: ['JOB', 'INTERNSHIP'],
  minFetchIntervalMinutes: 360,
  trustScore: 45,
  attributionRequired: true,
  attributionText: 'via RemoteOK',
  unavailableReason: null,
};

function toTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** Render a salary range only when the source actually gave numbers. */
function compensationOf(entry: RemoteOkEntry): string | null {
  const min = typeof entry.salary_min === 'number' && entry.salary_min > 0 ? entry.salary_min : null;
  const max = typeof entry.salary_max === 'number' && entry.salary_max > 0 ? entry.salary_max : null;
  if (min === null && max === null) return null;
  if (min !== null && max !== null) return `$${min.toLocaleString()} – $${max.toLocaleString()}`;
  return `$${(min ?? max)!.toLocaleString()}`;
}

export const remoteOkConnector: SourceConnector = {
  meta,

  async fetch({ signal, log }: FetchContext): Promise<RawOpportunity[]> {
    const payload = await getJson<RemoteOkEntry[]>(ENDPOINT, { signal, attempts: 2 });
    const entries = Array.isArray(payload) ? payload : [];
    log.debug({ received: entries.length }, 'remoteok responded');

    return entries.flatMap((entry): RawOpportunity[] => {
      // Skip the attribution notice that leads the feed.
      if (entry.legal !== undefined) return [];

      const title = typeof entry.position === 'string' ? entry.position : '';
      const url = entry.url ?? entry.apply_url;
      if (title.length === 0 || typeof url !== 'string') return [];

      return [
        {
          title,
          organization: entry.company ?? null,
          description: entry.description ?? null,
          // RemoteOK lists only remote roles.
          remote: true,
          location: entry.location && entry.location.trim().length > 0 ? entry.location : null,
          country: null,
          deadline: null,
          applicationUrl: entry.apply_url ?? url,
          sourceUrl: url,
          datePosted:
            typeof entry.epoch === 'number' ? safeDate(new Date(entry.epoch * 1000)) : safeDate(entry.date),
          tags: toTags(entry.tags),
          skills: toTags(entry.tags),
          compensation: compensationOf(entry),
          externalId: entry.id !== undefined ? String(entry.id) : (entry.slug ?? null),
        },
      ];
    });
  },
};
