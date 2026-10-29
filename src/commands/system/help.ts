/**
 * `.help` — generated from the registry, so it can never drift out of date.
 *
 * `.help <command>` gives usage and examples for one command.
 */
import { env } from '../../config/env.js';
import { POWERED_BY } from '../../whatsapp/format.js';
import { allCommands, commandsByCategory, findCommand } from '../registry.js';
import type { CommandCategory } from '../types.js';
import type { Command } from '../types.js';

const CATEGORY_TITLES: Record<CommandCategory, string> = {
  system: '⚙️ Getting started',
  jobs: '💼 Opportunities',
  scholarships: '🎓 Scholarships',
  internships: '🧪 Internships',
  fellowships: '🏅 Fellowships',
  research: '🔬 Research & funding',
  events: '📅 Events & training',
  news: '📰 News',
  members: '👤 Your profile',
  group: '👥 Group management',
  admin: '🛠️ Administration',
  ai: '🤖 Assistant',
};

/** Order categories so the useful things come first on a phone screen. */
const CATEGORY_ORDER: CommandCategory[] = [
  'jobs',
  'scholarships',
  'internships',
  'fellowships',
  'research',
  'events',
  'news',
  'members',
  'group',
  'ai',
  'system',
  'admin',
];

function renderOne(command: Command): string {
  const lines = [`*${command.usage}*`, command.summary];
  if (command.examples && command.examples.length > 0) {
    lines.push('', '*Examples*', ...command.examples.map((example) => `• \`${example}\``));
  }
  if (command.aliases && command.aliases.length > 0) {
    lines.push('', `Also: ${command.aliases.map((alias) => `\`${env.COMMAND_PREFIX}${alias}\``).join(', ')}`);
  }
  return lines.join('\n');
}

export const helpCommand: Command = {
  name: 'help',
  aliases: ['commands', 'h'],
  category: 'system',
  summary: 'List commands, or explain one',
  usage: '.help [command]',
  examples: ['.help', '.help jobs'],
  exemptFromRateLimit: true,

  async handler(context) {
    const requested = context.argv[0];

    if (requested) {
      const command = findCommand(requested.replace(/^\./, ''));
      if (!command) {
        await context.reply(
          `No command called \`${requested}\`. Run \`.help\` to see what is available.`,
        );
        return;
      }
      if (command.adminOnly && !context.isAdmin) {
        await context.reply(`No command called \`${requested}\`. Run \`.help\` to see what is available.`);
        return;
      }
      await context.reply(renderOne(command));
      return;
    }

    const grouped = commandsByCategory(context.isAdmin);
    const sections: string[] = [];

    for (const category of CATEGORY_ORDER) {
      const commands = grouped.get(category);
      if (!commands || commands.length === 0) continue;
      const lines = commands.map(
        (command) => `• \`${command.usage}\` — ${command.summary}`,
      );
      sections.push([`*${CATEGORY_TITLES[category]}*`, ...lines].join('\n'));
    }

    const header = [
      '🏛️ *PUBLIC HEALTH COLOSSEUM*',
      '_Learn. Connect. Unlock opportunities._',
      '',
      `All commands start with \`${env.COMMAND_PREFIX}\`. ${allCommands().length} available.`,
    ].join('\n');

    const footer = [
      '*Tip*',
      'Filters stack: `.jobs nairobi internship today`',
      '',
      `Run \`.help <command>\` for examples.`,
      '',
      `_${POWERED_BY}_`,
    ].join('\n');

    await context.reply([header, '', sections.join('\n\n'), '', footer].join('\n'));
  },
};
