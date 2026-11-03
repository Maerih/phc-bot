/**
 * Try the site tracker against live sites without WhatsApp or the database:
 *
 *   npm run tracker:check -- kemri jobwebkenya        (sites by slug)
 *   npm run tracker:check                             (a sample of sites)
 *
 * Prints which listings were judged public-health and the cards they become.
 */
import { aiAvailable, basicCard, classifyTitles, extractCard } from '../tracker/ai.js';
import { renderCard } from '../tracker/card.js';
import { extractLinks, htmlToText, listingCandidates } from '../tracker/html.js';
import { isGenericTitle, isHealthish, keywordVerdict } from '../tracker/relevance.js';
import { TRACKED_SITES } from '../tracker/sites.js';
import { USER_AGENT } from '../sources/common/http.js';

async function get(url: string): Promise<{ html: string; url: string } | null> {
  try {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(25_000) });
    return response.ok ? { html: await response.text(), url: response.url || url } : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const sites = wanted.length > 0 ? TRACKED_SITES.filter((site) => wanted.includes(site.slug)) : TRACKED_SITES.slice(0, 3);
  console.log(`AI selection: ${aiAvailable() ? 'on' : 'off (keywords)'}\n`);

  for (const site of sites) {
    const page = await get(site.url);
    if (!page) {
      console.log(`✗ ${site.name}: could not be read\n`);
      continue;
    }
    const candidates = listingCandidates(page.html, page.url);
    const judged = candidates.filter((candidate) => !isGenericTitle(candidate.text) && (site.health || isHealthish(candidate.text)));
    const verdict = await classifyTitles(judged.map((c) => ({ title: c.text, url: c.url })), site);
    const relevant = judged.filter((c, i) => (verdict ? verdict.has(i) : keywordVerdict(c.text, site.health)));
    console.log(`● ${site.name}: ${candidates.length} listings, ${judged.length} judged, ${relevant.length} public-health`);
    for (const item of relevant.slice(0, 8)) console.log(`    - ${item.text}`);

    const first = relevant[0];
    if (!first) {
      console.log('');
      continue;
    }
    const detail = /\.pdf($|\?)/i.test(first.url) ? null : await get(first.url);
    const base = { listingTitle: first.text, listingUrl: first.url, site };
    const card = detail
      ? await extractCard({ ...base, pageText: htmlToText(detail.html), links: extractLinks(detail.html, detail.url).filter((l) => l.external) })
      : basicCard(base);
    console.log('\n  Card for the first one:\n');
    console.log(
      card === null
        ? '  (on reading the page, not a public-health opportunity)'
        : renderCard(card === 'unavailable' ? basicCard(base) : card).replace(/^/gm, '  │ '),
    );
    console.log('');
  }
}

main().then(
  () => process.exit(0),
  (cause) => {
    console.error(cause);
    process.exit(1);
  },
);
