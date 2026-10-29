/**
 * `.job` and `.jobs` — the primary opportunity search.
 *
 * Both accept free text plus filters; neither forces a type, so
 * `.jobs scholarship` still reaches scholarships. The two names exist because
 * members reach for both, and silently failing on one would be a papercut.
 */
import { runSearch } from '../opportunities/run-search.js';
import type { Command } from '../types.js';

export const jobCommand: Command = {
  name: 'job',
  category: 'jobs',
  summary: 'Search opportunities by keyword',
  usage: '.job <keywords>',
  examples: ['.job public health', '.job epidemiology', '.job health informatics', '.job cybersecurity'],
  async handler(context) {
    await runSearch(context, { commandLabel: '.job' });
  },
};

export const jobsCommand: Command = {
  name: 'jobs',
  category: 'jobs',
  summary: 'Search opportunities by location, type or recency',
  usage: '.jobs <location | type | today | latest>',
  examples: ['.jobs Nairobi', '.jobs Kenya', '.jobs remote', '.jobs today', '.jobs internship', '.jobs africa'],
  async handler(context) {
    await runSearch(context, { commandLabel: '.jobs' });
  },
};
