/**
 * `.about` — what the community is, and an honest statement of what the
 * assistant does and does not guarantee.
 */
import { POWERED_BY } from '../../whatsapp/format.js';
import type { Command } from '../types.js';

export const aboutCommand: Command = {
  name: 'about',
  category: 'system',
  summary: 'About the Colosseum',
  usage: '.about',
  exemptFromRateLimit: true,

  async handler(context) {
    await context.reply(
      [
        '🏛️ *PUBLIC HEALTH COLOSSEUM*',
        '',
        'A global community where students, early professionals, researchers and',
        'practitioners learn, connect and unlock opportunities in public health.',
        '',
        '*Mission*',
        'To create a space where people access opportunities, develop clarity and',
        'position themselves for growth in public health.',
        '',
        '*What this assistant does*',
        '• Searches jobs, internships, scholarships, fellowships, research and events',
        '• Normalises what it finds into one readable format',
        '• Removes duplicates and hides anything past its deadline',
        '• Links you straight to the official application page',
        '',
        '*What it does not do*',
        'Listings are gathered from third-party sources. Unless a result is marked',
        'as verified, it has not been independently checked — always confirm the',
        'details on the official page before applying, and never pay to apply.',
        '',
        `_${POWERED_BY}_`,
      ].join('\n'),
    );
  },
};
