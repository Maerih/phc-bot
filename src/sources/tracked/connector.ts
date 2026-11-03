/**
 * The site tracker's finds, as a search source.
 *
 * The tracker reads the Kenyan and international opportunity sites on its own
 * schedule; this connector only reads what it stored, so searching costs no
 * extra requests to anyone.
 */
import type { RawOpportunity } from '../../domain/opportunity.js';
import { basicCard } from '../../tracker/ai.js';
import { TRACKED_SITES } from '../../tracker/sites.js';
import { recentRelevant } from '../../tracker/store.js';
import type { ConnectorMeta, FetchContext, SourceConnector } from '../types.js';

const meta: ConnectorMeta = {
  slug: 'tracked-sites',
  name: 'Kenyan opportunity sites',
  kind: 'SCRAPE',
  homepageUrl: 'https://github.com/Maerih/phc-bot',
  supplies: ['JOB', 'INTERNSHIP', 'SCHOLARSHIP', 'FELLOWSHIP', 'GRANT', 'VOLUNTEER', 'TRAINING', 'CONFERENCE', 'PROGRAM'],
  // Reads the local database only, so it can be asked every time.
  minFetchIntervalMinutes: 1,
  trustScore: 70,
  attributionRequired: false,
  unavailableReason: null,
};

export const trackedSitesConnector: SourceConnector = {
  meta,
  async fetch({ query }: FetchContext): Promise<RawOpportunity[]> {
    const rows = await recentRelevant(60, 400);
    const terms = query.terms
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 2);

    return rows.flatMap((row): RawOpportunity[] => {
      const site = TRACKED_SITES.find((entry) => entry.slug === row.site_slug);
      const card =
        row.card ??
        basicCard({
          listingTitle: row.title,
          listingUrl: row.listing_url,
          site: site ?? { name: row.site_slug, defaultType: 'JOB', kenya: true },
        });
      const haystack = [card.title, card.organization, card.field, card.summary, card.location].join(' ').toLowerCase();
      if (terms.length > 0 && !terms.some((term) => haystack.includes(term))) return [];
      return [
        {
          title: card.title,
          organization: card.organization,
          description: card.summary,
          type: card.type,
          location: card.location,
          country: /kenya|nairobi|kisumu|mombasa|nakuru|eldoret/i.test(card.location ?? '') || site?.kenya ? 'KE' : null,
          remote: /remote/i.test(card.location ?? '') || null,
          eligibility: card.requirements,
          deadline: card.deadline ? new Date(`${card.deadline}T23:59:59+03:00`) : null,
          applicationUrl: card.applyUrl,
          sourceUrl: row.listing_url,
          datePosted: row.first_seen_at,
          tags: [card.field ?? 'public health'],
          compensation: card.salary,
          externalId: row.url_hash,
        },
      ];
    });
  },
};
