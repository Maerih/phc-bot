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
import { dripRange, pushAll, runScan, setDripRange, trackerStatus } from '../../tracker/service.js';
import { parseDripRange, type DripRange } from '../../tracker/schedule.js';
import * as store from '../../tracker/store.js';
import { guardGroup } from '../group/common.js';
import type { Command, CommandContext } from '../types.js';

function schedule(range: DripRange): string {
  const gap = range.minMinutes === range.maxMinutes ? `${range.minMinutes}` : `${range.minMinutes}–${range.maxMinutes}`;
  return [
    '🕒 *Schedule (Nairobi time)*',
    `• Monday 3:00 AM – Friday 1:00 PM: a new opportunity every ${gap} minutes`,
    '• Friday 2:00 PM: the weekly report, with a spreadsheet of everything found',
    '• Weekends: rest — updates resume on Monday',
  ].join('\n');
}

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
      `LinkedIn & job-index searches (JSearch): ${state.jsearch ? 'on, daily' : 'off (needs JSEARCH_API_KEY)'}`,
      '',
      schedule(state.drip),
      '',
      '`.alerts on` · `.alerts off` · `.alerts sites`',
      'Admins: `.scan` · `.pushall` · `.alerts interval 3-5` · `.alerts pause`',
    ].join('\n'),
  );
}

/** Read every site now; platform administrators only, as it is heavy. */
async function scanNow(context: CommandContext): Promise<void> {
  if (!context.isAdmin) {
    await context.reply('Only platform administrators can start a scan by hand.');
    return;
  }
  await context.react('⏳');
  await context.reply('🔎 Scanning every site now. This takes about a minute…');
  const results = await runScan();
  if (results.length === 0) {
    await context.reply('A scan is already running; the results will be in `.alerts` in a minute or two.');
    return;
  }
  const reachable = results.filter((result) => result.ok).length;
  const fresh = results.reduce((sum, result) => sum + result.fresh, 0);
  const found = results.reduce((sum, result) => sum + result.relevant, 0);
  const state = await trackerStatus();
  await context.reply(
    [
      '✅ *Scan finished*',
      `Sites read: ${reachable} of ${results.length}`,
      `New listings seen: ${fresh}`,
      `New public-health opportunities: *${found}*`,
      `Waiting to be sent: ${state.queue}`,
      '',
      'Send them all at once with `.pushall`, or let them arrive one by one.',
    ].join('\n'),
  );
}

/**
 * Every valid, unpublished opportunity — including those collected earlier in
 * the week — checked, de-duplicated, grouped by category and sent as a list
 * and a spreadsheet. A platform administrator broadcasts to every chat with
 * alerts on (and this one); a group admin, to this group.
 */
async function pushAllHere(context: CommandContext): Promise<void> {
  if (!context.isAdmin && !(context.isGroup && (await mayChange(context)))) {
    if (!context.isGroup) await context.reply('Only platform administrators can push every opportunity at once.');
    return;
  }
  const chats = context.isAdmin ? [...new Set([context.chatJid, ...(await store.subscribers())])] : [context.chatJid];
  await context.react('📤');
  try {
    const result = await pushAll(chats, (message) => context.reply(message));
    const dropped = result.checked.expired + result.checked.closed + result.checked.stale + result.checked.undated;
    await context.reply(
      result.published === 0
        ? [
            '✅ Nothing new to send: every valid opportunity has already gone to these chats.',
            dropped + result.checked.duplicate > 0
              ? `(${dropped} expired or outdated and ${result.checked.duplicate} duplicates were left out.)`
              : '',
            'Try `.scan` to look for new ones.',
          ]
            .filter(Boolean)
            .join('\n')
        : [
            `✅ *${result.published}* opportunities sent to ${result.chats} chat${result.chats === 1 ? '' : 's'}.`,
            `Left out: ${dropped} expired or outdated, ${result.checked.duplicate} duplicates, ${result.checked.irrelevant} not public health.`,
            'Each chat gets each opportunity only once; running `.pushall` again sends only what is new.',
          ].join('\n'),
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    context.log.warn({ err: message }, 'push all failed');
    await context.reply(
      message.includes('already running') ? 'A `.pushall` is already running — its results will arrive shortly.' : 'Could not send the list just now. Please try again in a minute.',
    );
  }
}

export const scanCommand: Command = {
  name: 'scan',
  category: 'group',
  summary: 'Read every opportunity site right now (admins)',
  usage: '.scan',
  async handler(context) {
    await scanNow(context);
  },
};

export const pushAllCommand: Command = {
  name: 'pushall',
  aliases: ['sendall'],
  category: 'group',
  summary: 'Send every waiting opportunity here at once, as a list and spreadsheet (admins)',
  usage: '.pushall',
  async handler(context) {
    await pushAllHere(context);
  },
};

export const alertsCommand: Command = {
  name: 'alerts',
  aliases: ['updates', 'track'],
  category: 'group',
  summary: 'Public-health opportunity updates in this chat',
  usage: '.alerts <on|off|sites|interval|scan|pushall>',
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
          schedule(await dripRange()),
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

    if (sub === 'check' || sub === 'scan') {
      await scanNow(context);
      return;
    }

    if (sub === 'pushall' || sub === 'all') {
      await pushAllHere(context);
      return;
    }

    if (sub === 'interval' || sub === 'every') {
      if (!context.isAdmin) {
        await context.reply('Only platform administrators can change how often opportunities are sent.');
        return;
      }
      const range = parseDripRange(context.argv.slice(1).join(''));
      if (!range) {
        const current = await dripRange();
        await context.reply(
          `Opportunities go out every ${current.minMinutes}–${current.maxMinutes} minutes.\n\n` +
            'Change it with `.alerts interval 3` (every 3 minutes) or `.alerts interval 3-5` (a random gap of 3 to 5 minutes). ' +
            'Anything from 1 to 120 minutes.',
        );
        return;
      }
      await setDripRange(range);
      await context.reply(
        `⏱️ Opportunities now go out every ${range.minMinutes === range.maxMinutes ? range.minMinutes : `${range.minMinutes}–${range.maxMinutes}`} minutes, in every chat with alerts on.`,
      );
      return;
    }

    await status(context);
  },
};
