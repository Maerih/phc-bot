/**
 * `.start` and `.menu` — the first thing a new member sees.
 *
 * Kept short on purpose: a wall of 800 commands is how the previous bot lost
 * people. Four things you can do, and where to go next.
 */
import { POWERED_BY } from '../../whatsapp/format.js';
import type { Command, CommandContext } from '../types.js';

async function sendMenu(context: CommandContext): Promise<void> {
  const body = [
    '🏛️ *PUBLIC HEALTH COLOSSEUM*',
    '_An arena for exposure, growth and opportunity._',
    '',
    '*Find opportunities*',
    '• `.job public health` — search by keyword',
    '• `.jobs nairobi` — search by location',
    '• `.jobs today` — what is new',
    '',
    '*By type*',
    '• `.scholarships` · `.internships`',
    '• `.fellowships` · `.research`',
    '• `.events` · `.training`',
    '',
    '*Move through results*',
    '• `.next` · `.prev` · `.details 1`',
    '',
    '*Everything else*',
    '• `.help` — full command list',
    '• `.about` — what this community is',
    '• `.sources` — where opportunities come from',
    '',
    `_${POWERED_BY}_`,
  ].join('\n');

  await context.reply(body);
}

export const menuCommand: Command = {
  name: 'menu',
  category: 'system',
  summary: 'Show the main menu',
  usage: '.menu',
  exemptFromRateLimit: true,
  async handler(context) {
    await sendMenu(context);
  },
};

export const startCommand: Command = {
  name: 'start',
  category: 'system',
  summary: 'Get started',
  usage: '.start',
  exemptFromRateLimit: true,
  async handler(context) {
    await sendMenu(context);
  },
};
