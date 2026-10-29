/**
 * Search from the terminal — the same pipeline WhatsApp uses.
 *
 *   npm run search -- public health
 *   npm run search -- nairobi internship
 *   npm run search -- --json epidemiology
 *   npm run search -- --ai "public health nairobi"   (AI web fallback)
 *
 * Useful for exercising sources, normalisation, de-duplication and ranking
 * without a WhatsApp connection, and for checking what members would actually
 * receive.
 */
import { parseQuery } from '../search/query.js';
import { describeSources, flushPersistence, search } from '../search/search.service.js';
import { renderResults } from '../whatsapp/format.js';
import { closeDatabase } from '../db/client.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const noPersist = argv.includes('--no-persist');
  // Opt-in: the fallback calls a paid API, so it never fires unasked here.
  const allowAiFallback = argv.includes('--ai');
  const terms = argv.filter((arg) => !arg.startsWith('--')).join(' ');

  const query = parseQuery(terms, { limit: 5, offset: 0 });

  // In --json mode stdout must carry only JSON so it can be piped; the
  // human-readable preamble goes to stderr.
  const note = asJson ? process.stderr : process.stdout;
  note.write(`\nSources: ${describeSources()
    .filter((source) => source.enabled && !source.unavailableReason)
    .map((source) => source.name)
    .join(', ') || '(none enabled)'}\n`);
  note.write(`Parsed query: ${JSON.stringify(query)}\n\n`);

  const outcome = await search(query, { persist: !noPersist, allowAiFallback });

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          totalMatched: outcome.totalMatched,
          aiAssisted: outcome.aiAssisted,
          degraded: outcome.degraded,
          durationMs: outcome.durationMs,
          sources: outcome.sources,
          results: outcome.results.map((entry) => ({
            score: entry.score,
            components: entry.components,
            title: entry.opportunity.title,
            organization: entry.opportunity.organization,
            type: entry.opportunity.type,
            categories: entry.opportunity.categories,
            country: entry.opportunity.country,
            remote: entry.opportunity.remote,
            deadline: entry.opportunity.deadline,
            source: entry.opportunity.sourceName,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write('─── per-source ───\n');
    for (const source of outcome.sources) {
      const detail = source.skippedReason
        ? `skipped — ${source.skippedReason}`
        : source.ok
          ? `${source.count} records${source.fromCache ? ' (cached)' : ''} in ${source.durationMs}ms`
          : `FAILED — ${source.error}`;
      process.stdout.write(`  ${source.name}: ${detail}\n`);
    }
    process.stdout.write(`\n─── rendered WhatsApp reply ───\n\n`);
    process.stdout.write(`${renderResults({ query, outcome, command: '.jobs' })}\n`);
  }

  // Let the background upserts finish before the pool goes away.
  await flushPersistence();
  await closeDatabase();
}

main().catch((cause) => {
  process.stderr.write(`\nsearch failed: ${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exit(1);
});
