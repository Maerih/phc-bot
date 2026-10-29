/**
 * `.details <n>` — full view of one result from the current page.
 */
import { renderDetails } from '../../whatsapp/format.js';
import type { Command } from '../types.js';

export const detailsCommand: Command = {
  name: 'details',
  aliases: ['detail', 'info'],
  category: 'jobs',
  summary: 'Full description of a result',
  usage: '.details <number>',
  examples: ['.details 1', '.details 3'],
  exemptFromRateLimit: true,
  async handler(context) {
    const session = context.getSession();

    if (!session || session.page.length === 0) {
      await context.reply('There is no recent search to open. Start one with `.jobs` or `.job <keywords>`.');
      return;
    }

    const raw = context.argv[0];
    const index = Number.parseInt(raw ?? '', 10);

    if (!Number.isInteger(index) || index < 1 || index > session.page.length) {
      await context.reply(
        `Pick a number between 1 and ${session.page.length}, for example \`.details 1\`.`,
      );
      return;
    }

    const entry = session.page[index - 1];
    if (!entry) {
      await context.reply('That result is no longer available. Run the search again.');
      return;
    }

    await context.reply(renderDetails(entry));
  },
};
