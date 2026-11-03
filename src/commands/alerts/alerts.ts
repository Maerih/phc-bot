/**
 * `.alerts` — public-health opportunity updates in this chat.
 *
 * In a group, a group admin (or platform administrator) turns them on or off;
 * in a direct chat, anyone can, for themselves. Pausing and resuming every
 * chat at once, and checking the sites immediately, are for platform
 * administrators.
 */
import { env } from '../../config/env.js';
import { TRACKED_SITES } from '../../tracker/sites.js';
import { runScan, trackerStatus } from '../../tracker/service.js';
import * as store from '../../tracker/store.js';
import { guardGroup } from '../group/common.js';
import type { Command, CommandContext } from '../types.js';

const SCHEDULE = [
  '🕒 *Schedule (Nairobi time)*',
  '• Monday 3:00 AM – Friday 1:00 PM: a new opportunity every 10–15 minutes',
  '• Friday 2:00 PM: the weekly report, with a spreadsheet of everything found',
  '• Weekends: rest — updates resume on Monday',
].join('\n');

async function mayChange(context: CommandContext): Promise<boolean> {
  if (!context.isGroup) return true;
  const guard = await guardGroup(context);
  return guard.ok;
}

async function status(context: CommandContext): Promise<void> {
  const state = await trackerStatus();
  const here = await store.isSubscribed(context.chatJid);
  const lastScan = state.lastScan
    ? `${state.lastScan.at.toLocaleString('en-GB', { timeZone: env.TIMEZONE, hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}, ${state.lastScan.found} new public-health finds`
    : 'not yet (the first check runs shortly after start-up)';
  await context.reply(
    [
      '📡 *Public-health opportunity alerts*',
      '',
      `In this chat: *${here ? 'ON' : 'OFF'}*${state.paused ? ' (paused for everyone by an administrator)' : ''}`,
      `Sites watched: ${state.sites} · checked every ${env.TRACKER_INTERVAL_MINUTES} minutes`,
      `Last check: ${lastScan}`,
      `Waiting to be sent: ${state.queue}`,
      `AI selection: ${state.ai ? 'on' : 'off (keyword matching)'}`,
      '',
      SCHEDULE,
      '',
      '`.alerts on` · `.alerts off` · `.alerts sites`',
    ].join('\n'),
  );
}

export const alertsCommand: Command = {
  name: 'alerts',
  aliases: ['updates', 'track'],
  category: 'group',
  summary: 'Public-health opportunity updates in this chat',
  usage: '.alerts <on|off|sites>',
  examples: ['.alerts on', '.alerts off', '.alerts'],
  async handler(context) {
    const sub = context.argv[0]?.toLowerCase();

    if (sub === 'on' || sub === 'start') {
      if (env.TRACKER_ENABLED !== 'on') {
        await context.reply('Opportunity tracking is switched off on this server (TRACKER_ENABLED=off).');
        return;
      }
      if (!(await mayChange(context))) return;
      const added = await store.subscribe(context.chatJid, context.senderJid);
      await context.reply(
        [
          added ? '✅ *Opportunity alerts are ON in this chat.*' : 'Alerts are already on in this chat.',
          '',
          `I watch ${TRACKED_SITES.length} Kenyan and international sites for public-health jobs, internships, scholarships, fellowships, grants and volunteering, and post them here as cards with the original link.`,
          '',
          SCHEDULE,
          '',
          'Stop any time with `.alerts off`.',
        ].join('\n'),
      );
      return;
    }

    if (sub === 'off' || sub === 'stop') {
      if (!(await mayChange(context))) return;
      const removed = await store.unsubscribe(context.chatJid);
      await context.reply(
        removed ? '🔕 Opportunity alerts are OFF in this chat. Turn them back on with `.alerts on`.' : 'Alerts were not on in this chat.',
      );
      return;
    }

    if (sub === 'sites') {
      await context.reply(
        `*Sites watched (${TRACKED_SITES.length})*\n\n${TRACKED_SITES.map((site) => `• ${site.name}`).join('\n')}`,
      );
      return;
    }

    if (sub === 'pause' || sub === 'resume') {
      if (!context.isAdmin) {
        await context.reply('Only platform administrators can pause or resume alerts for every chat.');
        return;
      }
      await store.setState('paused', sub === 'pause' ? '1' : '0');
      await context.reply(
        sub === 'pause'
          ? '⏸️ Alerts are paused in every chat. Sites are still checked. Resume with `.alerts resume`.'
          : '▶️ Alerts resumed.',
      );
      return;
    }

    if (sub === 'check') {
      if (!context.isAdmin) {
        await context.reply('Only platform administrators can start a check by hand.');
        return;
      }
      await context.react('⏳');
      const results = await runScan();
      if (results.length === 0) {
        await context.reply('A check is already running; try again in a few minutes.');
        return;
      }
      const reachable = results.filter((result) => result.ok).length;
      const found = results.reduce((sum, result) => sum + result.relevant, 0);
      await context.reply(`Checked ${reachable} of ${results.length} sites: ${found} new public-health opportunities queued.`);
      return;
    }

    await status(context);
  },
};
