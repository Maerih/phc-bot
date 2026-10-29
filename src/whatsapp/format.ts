/**
 * WhatsApp message rendering.
 *
 * Constraints this layer exists to respect:
 *  - phones are small: results are scannable, not walls of text
 *  - unknown stays unknown: a missing deadline renders as "not stated", never
 *    as an invented or omitted-and-implied date
 *  - attribution travels with the result, because some sources licence their
 *    data on that condition
 */
import { truncate } from '../core/text.js';
import type { ScoredOpportunity } from '../search/rank.js';
import { CATEGORY_LABELS, TYPE_LABELS, daysUntilDeadline } from '../domain/opportunity.js';
import type { SearchOutcome } from '../search/search.service.js';
import { describeQuery } from '../search/query.js';
import type { SearchQuery } from '../sources/types.js';

export const BRAND = 'Public Health Colosseum';
export const POWERED_BY = 'Powered by SCIAT SOLUTIONS';

const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/** WhatsApp bold. Applied to labels only, so the text stays readable as plain text. */
function bold(text: string): string {
  return `*${text}*`;
}

function numberFor(index: number): string {
  return NUMBER_EMOJI[index] ?? `${index + 1}.`;
}

/** Render a date as "12 Oct 2026" in the configured timezone-independent form. */
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Deadline line. Distinguishes three genuinely different states: a known date,
 * an explicitly absent one, and a rolling/unspecified one.
 */
function deadlineLine(opportunity: ScoredOpportunity['opportunity'], now: Date): string {
  if (!opportunity.deadline) return '⏰ Deadline: not stated';
  const days = daysUntilDeadline(opportunity, now);
  const date = formatDate(opportunity.deadline);
  if (days === null) return `⏰ Deadline: ${date}`;
  if (days === 0) return `⏰ Deadline: ${date} — ${bold('closes today')}`;
  if (days === 1) return `⏰ Deadline: ${date} — ${bold('1 day left')}`;
  if (days <= 7) return `⏰ Deadline: ${date} — ${bold(`${days} days left`)}`;
  return `⏰ Deadline: ${date} (${days} days)`;
}

function locationLine(opportunity: ScoredOpportunity['opportunity']): string {
  if (opportunity.remote === true) {
    return opportunity.location ? `📍 Remote — ${opportunity.location}` : '📍 Remote';
  }
  if (opportunity.location) return `📍 ${opportunity.location}`;
  return '📍 Location: not stated';
}

/** One result block. */
function renderEntry(entry: ScoredOpportunity, index: number, now: Date): string {
  const { opportunity } = entry;
  const lines: string[] = [];

  lines.push(`${numberFor(index)} ${bold(truncate(opportunity.title, 90))}`);
  lines.push(`🏢 ${opportunity.organization ?? 'Organisation not stated'}`);
  lines.push(locationLine(opportunity));

  // Only show a type badge when it is not the obvious default.
  if (opportunity.type !== 'JOB') lines.push(`🏷️ ${TYPE_LABELS[opportunity.type]}`);

  const primaryCategory = opportunity.categories.find((category) => category !== 'OTHER');
  if (primaryCategory) lines.push(`🎯 ${CATEGORY_LABELS[primaryCategory]}`);

  if (opportunity.educationLevel !== 'UNKNOWN') {
    lines.push(`🎓 ${opportunity.educationLevel.charAt(0)}${opportunity.educationLevel.slice(1).toLowerCase()}`);
  }

  if (opportunity.compensation) lines.push(`💰 ${truncate(opportunity.compensation, 60)}`);

  lines.push(deadlineLine(opportunity, now));

  if (opportunity.applicationUrl) lines.push(`🔗 ${opportunity.applicationUrl}`);
  lines.push(`📰 ${opportunity.sourceName}`);

  return lines.join('\n');
}

export interface RenderResultsOptions {
  query: SearchQuery;
  outcome: SearchOutcome;
  /** Command the member used, so pagination hints are accurate. */
  command: string;
  now?: Date;
}

/** Render a full results page. */
export function renderResults({ query, outcome, command, now = new Date() }: RenderResultsOptions): string {
  const { results, totalMatched, degraded, attributions } = outcome;

  if (results.length === 0) {
    return renderNoResults(query, outcome, command);
  }

  const from = query.offset + 1;
  const to = query.offset + results.length;

  const header = [
    `🔎 ${bold('PUBLIC HEALTH COLOSSEUM')}`,
    `${describeQuery(query)}`,
    `Showing ${from}–${to} of ${totalMatched}`,
  ].join('\n');

  const body = results.map((entry, index) => renderEntry(entry, index, now)).join('\n\n');

  const footer: string[] = [];

  const hasMore = to < totalMatched;
  const hints: string[] = [];
  if (hasMore) hints.push(`${bold(`.next`)} — more results`);
  if (query.offset > 0) hints.push(`${bold('.prev')} — previous page`);
  hints.push(`${bold('.save <n>')} — keep one`);
  hints.push(`${bold('.details <n>')} — full description`);
  footer.push(hints.join('\n'));

  if (outcome.aiAssisted) {
    // The member must know these did not come from a verified source. They
    // look identical otherwise, and that would be misleading.
    footer.push(
      '🔎 Our sources had nothing for this, so these came from a live web search by the assistant.\n' +
        '⚠️ Not verified — open each link and confirm the details before applying.',
    );
  }

  if (degraded) {
    const failed = outcome.sources.filter((source) => !source.ok).map((source) => source.name);
    // Told plainly: the member should know the list may be incomplete rather
    // than assume these are all the opportunities that exist.
    footer.push(`⚠️ Some sources were unreachable (${failed.join(', ')}), so this list may be incomplete.`);
  }

  if (attributions.length > 0) footer.push(`Listings ${attributions.join(', ')}.`);
  footer.push(`_${POWERED_BY}_`);

  return [header, '', body, '', footer.join('\n\n')].join('\n');
}

/** Empty-result message that explains *why* and suggests a next step. */
function renderNoResults(query: SearchQuery, outcome: SearchOutcome, command: string): string {
  const lines = [`🔎 ${bold('PUBLIC HEALTH COLOSSEUM')}`, '', `No matches for: ${describeQuery(query)}`];

  if (outcome.degraded) {
    const failed = outcome.sources.filter((source) => !source.ok).map((source) => source.name);
    lines.push('', `⚠️ ${failed.join(', ')} could not be reached, so there may be results we did not see.`);
  }

  const skipped = outcome.sources.filter((source) => source.skippedReason);
  if (skipped.length > 0) {
    lines.push('', `ℹ️ ${skipped.length} source(s) are not configured yet, which narrows what is searchable.`);
  }

  lines.push(
    '',
    bold('Try:'),
    `• A broader term — \`${command} public health\``,
    `• Drop the location — \`${command} ${query.terms || 'health'}\``,
    `• A different type — \`.scholarships\`, \`.internships\`, \`.fellowships\``,
    '',
    `_${POWERED_BY}_`,
  );

  return lines.join('\n');
}

/** Full detail view for `.details <n>`. */
export function renderDetails(entry: ScoredOpportunity, now = new Date()): string {
  const { opportunity } = entry;
  const lines: string[] = [
    `📋 ${bold(opportunity.title)}`,
    '',
    `🏢 ${opportunity.organization ?? 'Organisation not stated'}`,
    locationLine(opportunity),
    `🏷️ ${TYPE_LABELS[opportunity.type]}`,
    deadlineLine(opportunity, now),
  ];

  if (opportunity.categories.length > 0) {
    lines.push(`🎯 ${opportunity.categories.map((category) => CATEGORY_LABELS[category]).join(', ')}`);
  }
  if (opportunity.educationLevel !== 'UNKNOWN') lines.push(`🎓 ${opportunity.educationLevel}`);
  if (opportunity.experienceLevel !== 'UNKNOWN') lines.push(`📈 ${opportunity.experienceLevel}`);
  if (opportunity.compensation) lines.push(`💰 ${opportunity.compensation}`);

  if (opportunity.description) {
    lines.push('', bold('Description'), truncate(opportunity.description, 1200));
  }

  lines.push('');
  if (opportunity.applicationUrl) lines.push(`🔗 Apply: ${opportunity.applicationUrl}`);
  lines.push(`📰 Source: ${opportunity.sourceName}`);

  // Said explicitly, because "it appeared in the bot" is not verification.
  if (opportunity.verificationStatus === 'UNVERIFIED') {
    lines.push('', '⚠️ Not independently verified. Always confirm details on the official page before applying.');
  }

  lines.push('', `_${POWERED_BY}_`);
  return lines.join('\n');
}
