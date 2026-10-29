/**
 * Type shortcut commands.
 *
 * `.scholarships kenya` is the same pipeline as `.jobs kenya` with the type
 * pinned, which means "kenya" is read as a location rather than a search term.
 * Each is a few lines because the work lives in `runSearch`.
 */
import type { OpportunityType } from '../../domain/opportunity.js';
import { runSearch } from './run-search.js';
import type { Command } from '../types.js';

interface ShortcutSpec {
  name: string;
  aliases: string[];
  types: OpportunityType[];
  category: Command['category'];
  summary: string;
  examples: string[];
}

function shortcut(spec: ShortcutSpec): Command {
  return {
    name: spec.name,
    aliases: spec.aliases,
    category: spec.category,
    summary: spec.summary,
    usage: `.${spec.name} [location | keywords]`,
    examples: spec.examples,
    async handler(context) {
      await runSearch(context, { forcedTypes: spec.types, commandLabel: `.${spec.name}` });
    },
  };
}

export const scholarshipsCommand = shortcut({
  name: 'scholarships',
  aliases: ['scholarship'],
  types: ['SCHOLARSHIP'],
  category: 'scholarships',
  summary: 'Scholarships and tuition funding',
  examples: ['.scholarships', '.scholarships kenya', '.scholarships masters'],
});

export const internshipsCommand = shortcut({
  name: 'internships',
  aliases: ['internship'],
  types: ['INTERNSHIP'],
  category: 'internships',
  summary: 'Internships and attachments',
  examples: ['.internships', '.internships nairobi', '.internships remote'],
});

export const fellowshipsCommand = shortcut({
  name: 'fellowships',
  aliases: ['fellowship'],
  types: ['FELLOWSHIP'],
  category: 'fellowships',
  summary: 'Fellowships and fellow programmes',
  examples: ['.fellowships', '.fellowships africa', '.fellowships global health'],
});

export const researchCommand = shortcut({
  name: 'research',
  aliases: ['projects'],
  types: ['RESEARCH'],
  category: 'research',
  summary: 'Research posts, PhD and postdoc openings',
  examples: ['.research', '.research epidemiology', '.research remote'],
});

export const grantsCommand = shortcut({
  name: 'grants',
  aliases: ['grant', 'funding'],
  types: ['GRANT'],
  category: 'research',
  summary: 'Grants and calls for proposals',
  examples: ['.grants', '.grants africa'],
});

export const eventsCommand = shortcut({
  name: 'events',
  aliases: ['event'],
  types: ['EVENT', 'CONFERENCE'],
  category: 'events',
  summary: 'Events, webinars and summits',
  examples: ['.events', '.events upcoming', '.events nairobi'],
});

export const conferencesCommand = shortcut({
  name: 'conferences',
  aliases: ['conference'],
  types: ['CONFERENCE'],
  category: 'events',
  summary: 'Conferences and calls for abstracts',
  examples: ['.conferences', '.conferences public health'],
});

export const trainingCommand = shortcut({
  name: 'training',
  aliases: ['trainings', 'courses'],
  types: ['TRAINING'],
  category: 'events',
  summary: 'Short courses, workshops and training',
  examples: ['.training', '.training epidemiology'],
});
