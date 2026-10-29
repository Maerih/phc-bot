/**
 * `.sources` — where opportunities come from.
 *
 * Visible to every member, not just administrators: a member deciding whether
 * to trust a listing deserves to know which sources were searched and which
 * were not available.
 */
import { describeSources } from '../../search/search.service.js';
import { POWERED_BY } from '../../whatsapp/format.js';
import type { Command } from '../types.js';

export const sourcesCommand: Command = {
  name: 'sources',
  aliases: ['source'],
  category: 'system',
  summary: 'Which sources are searched',
  usage: '.sources',
  exemptFromRateLimit: true,

  async handler(context) {
    const sources = describeSources();
    const lines: string[] = ['📰 *OPPORTUNITY SOURCES*', ''];

    const active = sources.filter((source) => source.enabled && !source.unavailableReason);
    const inactive = sources.filter((source) => !source.enabled || source.unavailableReason);

    if (active.length > 0) {
      lines.push('*Active*');
      for (const source of active) {
        lines.push(`• ${source.name} — trust ${source.trustScore}/100`);
      }
    } else {
      lines.push('*Active*', '• None configured.');
    }

    if (inactive.length > 0) {
      lines.push('', '*Not active*');
      for (const source of inactive) {
        // Administrators get the actionable reason; members just see that it
        // is off, since the reason names environment variables.
        const reason = context.isAdmin
          ? (source.unavailableReason ?? 'not enabled in SOURCES_ENABLED')
          : 'not enabled';
        lines.push(`• ${source.name} — ${reason}`);
      }
    }

    lines.push(
      '',
      'Results link to the original posting. Always apply through the official page.',
      '',
      `_${POWERED_BY}_`,
    );

    await context.reply(lines.join('\n'));
  },
};
