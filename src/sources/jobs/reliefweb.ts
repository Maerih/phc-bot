/**
 * ReliefWeb (OCHA) — UN, NGO and humanitarian vacancies.
 *
 * This is the highest-value source for the Colosseum: WHO, UNICEF, UNFPA,
 * MSF, IRC and national health ministries post here, with real closing dates.
 *
 * ── Status ──────────────────────────────────────────────────────────────────
 * DISABLED until an appname is configured. ReliefWeb decommissioned API v1 and
 * v2 rejects unregistered callers with HTTP 403 ("You are not using an approved
 * appname"). Registration is free:
 *   https://apidoc.reliefweb.int/parameters#appname
 * Set RELIEFWEB_APPNAME and add `reliefweb` to SOURCES_ENABLED to turn it on.
 *
 * ── Caveat ──────────────────────────────────────────────────────────────────
 * The request and response mapping below follows ReliefWeb's published v2 API
 * documentation but has NOT been exercised against the live endpoint, because
 * this platform has no approved appname yet. Treat the field mapping as
 * unverified until the first successful sync, and check `.admin sources` output
 * after enabling it.
 */
import { env } from '../../config/env.js';
import { safeDate } from '../../domain/normalize.js';
import type { RawOpportunity } from '../../domain/opportunity.js';
import { getJson } from '../common/http.js';
import type { ConnectorMeta, FetchContext, SourceConnector } from '../types.js';

const ENDPOINT = 'https://api.reliefweb.int/v2/jobs';

interface ReliefWebNamed {
  name?: string;
  iso3?: string;
}

interface ReliefWebJobFields {
  title?: string;
  body?: string;
  url?: string;
  url_alias?: string;
  date?: { created?: string; closing?: string };
  source?: ReliefWebNamed[];
  country?: ReliefWebNamed[];
  city?: ReliefWebNamed[];
  career_categories?: ReliefWebNamed[];
  experience?: ReliefWebNamed[];
  theme?: ReliefWebNamed[];
  type?: ReliefWebNamed[];
}

interface ReliefWebEntry {
  id?: string | number;
  fields?: ReliefWebJobFields;
}

interface ReliefWebResponse {
  data?: ReliefWebEntry[];
}

/** ISO-3166 alpha-3 -> alpha-2 for the countries this community cares about. */
const ISO3_TO_ISO2: Record<string, string> = {
  KEN: 'KE', UGA: 'UG', TZA: 'TZ', RWA: 'RW', ETH: 'ET', NGA: 'NG', GHA: 'GH',
  ZAF: 'ZA', SSD: 'SS', SOM: 'SO', SDN: 'SD', ZMB: 'ZM', ZWE: 'ZW', MWI: 'MW',
  MOZ: 'MZ', BWA: 'BW', NAM: 'NA', COD: 'CD', CMR: 'CM', SEN: 'SN', CIV: 'CI',
  EGY: 'EG', MAR: 'MA', CHE: 'CH', GBR: 'GB', USA: 'US', BEL: 'BE', NLD: 'NL',
  DNK: 'DK', DEU: 'DE', FRA: 'FR', IND: 'IN', PHL: 'PH', THA: 'TH', AUS: 'AU',
  CAN: 'CA',
};

function names(entries: ReliefWebNamed[] | undefined): string[] {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => entry.name).filter((name): name is string => typeof name === 'string');
}

function buildMeta(): ConnectorMeta {
  const appname = env.RELIEFWEB_APPNAME.trim();
  return {
    slug: 'reliefweb',
    name: 'ReliefWeb',
    kind: 'API',
    homepageUrl: 'https://reliefweb.int/jobs',
    supplies: ['JOB', 'INTERNSHIP', 'VOLUNTEER'],
    minFetchIntervalMinutes: 120,
    // Highest trust of the configured sources: these are first-party postings
    // from the organisations themselves, with real deadlines.
    trustScore: 90,
    attributionRequired: true,
    attributionText: 'via ReliefWeb (OCHA)',
    unavailableReason:
      appname.length > 0
        ? null
        : 'RELIEFWEB_APPNAME is not set — request a free appname at https://apidoc.reliefweb.int/parameters#appname',
  };
}

export const reliefwebConnector: SourceConnector = {
  meta: buildMeta(),

  async fetch({ query, signal, log }: FetchContext): Promise<RawOpportunity[]> {
    const appname = env.RELIEFWEB_APPNAME.trim();
    if (appname.length === 0) {
      // Defensive: the registry should already have skipped this connector.
      return [];
    }

    // ReliefWeb uses bracketed query parameters, which URLSearchParams would
    // percent-encode into a form the API does not accept, so the query string
    // is assembled explicitly.
    const parts: string[] = [
      `appname=${encodeURIComponent(appname)}`,
      'profile=list',
      `limit=${Math.min(100, Math.max(10, query.limit * 4))}`,
      'sort[]=date.created:desc',
    ];
    for (const field of [
      'title', 'body', 'url', 'url_alias', 'date.created', 'date.closing',
      'source.name', 'country.name', 'country.iso3', 'city.name',
      'career_categories.name', 'experience.name', 'theme.name', 'type.name',
    ]) {
      parts.push(`fields[include][]=${encodeURIComponent(field)}`);
    }
    if (query.terms.trim().length > 0) {
      parts.push(`query[value]=${encodeURIComponent(query.terms.trim())}`);
      parts.push('query[operator]=AND');
    }

    const payload = await getJson<ReliefWebResponse>(`${ENDPOINT}?${parts.join('&')}`, {
      signal,
      attempts: 2,
    });
    const entries = Array.isArray(payload.data) ? payload.data : [];
    log.debug({ received: entries.length }, 'reliefweb responded');

    return entries.flatMap((entry): RawOpportunity[] => {
      const fields = entry.fields ?? {};
      const title = typeof fields.title === 'string' ? fields.title : '';
      if (title.length === 0) return [];

      const countries = Array.isArray(fields.country) ? fields.country : [];
      // Only pin a country when the posting names exactly one.
      const iso3 = countries.length === 1 ? countries[0]?.iso3?.toUpperCase() : undefined;
      const countryName = countries.length === 1 ? countries[0]?.name : undefined;
      const city = names(fields.city)[0];

      const careerCategories = names(fields.career_categories);
      const themes = names(fields.theme);
      const jobTypes = names(fields.type);
      const url = fields.url_alias ?? fields.url ?? null;

      return [
        {
          title,
          organization: names(fields.source)[0] ?? null,
          description: fields.body ?? null,
          location: [city, countryName].filter(Boolean).join(', ') || null,
          country: iso3 ? (ISO3_TO_ISO2[iso3] ?? null) : null,
          // ReliefWeb postings carry a duty station rather than a remote flag;
          // leave it unknown rather than asserting either way.
          remote: null,
          deadline: safeDate(fields.date?.closing),
          datePosted: safeDate(fields.date?.created),
          applicationUrl: url,
          sourceUrl: url,
          tags: [...careerCategories, ...themes, ...jobTypes],
          skills: themes,
          compensation: null,
          externalId: entry.id !== undefined ? String(entry.id) : null,
        },
      ];
    });
  },
};
