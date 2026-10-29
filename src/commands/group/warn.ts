/**
 * Warnings: issue, review and clear.
 *
 * Warnings are an append-only log, not a counter, so an administrator asked
 * "why was this person removed?" can answer with evidence.
 */
import {
  clearWarnings,
  countActiveWarnings,
  getGroupSettings,
  issueWarning,
  listWarnings,
} from '../../db/repositories/groups.js';
import { findParticipant, resolveTargets, type GroupInfo } from '../../whatsapp/group.js';
import { displayJid, guardGroup, mentionsFor } from './common.js';
import type { Command } from '../types.js';

/**
 * The id warnings are recorded under: the phone JID whenever the group
 * discloses it. Automatic moderation warns by phone JID, so a mention that
 * arrives as a LID must resolve to the same person or their count splits.
 */
function warningKey(info: GroupInfo | undefined, target: string): string {
  return (info && findParticipant(info, target)?.phoneJid) || target;
}

export const warnCommand: Command = {
  name: 'warn',
  category: 'group',
  summary: 'Warn a member',
  usage: '.warn @user [reason]',
  examples: ['.warn @user off-topic promotion'],
  async handler(context) {
    const guard = await guardGroup(context);
    if (!guard.ok) return;

    const targets = resolveTargets(context.mentionedJids, context.argv);
    if (targets.length !== 1) {
      await context.reply('Mention exactly one person, for example `.warn @user spamming`.');
      return;
    }

    const target = targets[0] as string;
    const key = warningKey(guard.info, target);
    // The reason is whatever is left once the mention token is removed.
    const reason = context.argv
      .filter((token) => !token.startsWith('@') && !/^\d{6,}$/.test(token))
      .join(' ')
      .trim();

    const settings = await getGroupSettings(context.chatJid);
    const count = await issueWarning({
      groupJid: context.chatJid,
      targetJid: key,
      issuedBy: context.senderJid,
      reason: reason.length > 0 ? reason.slice(0, 300) : null,
    });

    const lines = [
      `${displayJid(target)} warned (${count}/${settings.warnLimit}).`,
      reason.length > 0 ? `Reason: ${reason}` : 'No reason given.',
    ];

    if (count >= settings.warnLimit) {
      // Deliberately not automatic: removal is an administrator's decision, and
      // an AI or a counter should not be the thing that ejects a member.
      lines.push('', `They have reached the warning limit. An admin can remove them with \`.kick\`.`);
    }

    await context.reply(lines.join('\n'), { mentions: mentionsFor([target]) });
  },
};

export const warningsCommand: Command = {
  name: 'warnings',
  aliases: ['warns'],
  category: 'group',
  summary: 'Show a member’s warnings',
  usage: '.warnings @user',
  examples: ['.warnings @user'],
  async handler(context) {
    const guard = await guardGroup(context);
    if (!guard.ok) return;

    const targets = resolveTargets(context.mentionedJids, context.argv);
    if (targets.length !== 1) {
      await context.reply('Mention exactly one person, for example `.warnings @user`.');
      return;
    }

    const target = targets[0] as string;
    const key = warningKey(guard.info, target);
    const entries = await listWarnings(context.chatJid, key);

    if (entries.length === 0) {
      await context.reply(`${displayJid(target)} has no active warnings.`, {
        mentions: mentionsFor([target]),
      });
      return;
    }

    const settings = await getGroupSettings(context.chatJid);
    const lines = [`*${displayJid(target)}* — ${entries.length}/${settings.warnLimit} warnings`, ''];

    for (const entry of entries) {
      const when = entry.createdAt.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      });
      const by = entry.issuedBy === 'system' ? 'automatic' : displayJid(entry.issuedBy);
      lines.push(`• ${when} — ${entry.reason ?? 'no reason given'} (by ${by})`);
    }

    await context.reply(lines.join('\n'), { mentions: mentionsFor([target]) });
  },
};

export const resetWarnsCommand: Command = {
  name: 'resetwarns',
  aliases: ['clearwarns', 'unwarn'],
  category: 'group',
  summary: 'Clear a member’s warnings',
  usage: '.resetwarns @user',
  examples: ['.resetwarns @user'],
  async handler(context) {
    const guard = await guardGroup(context);
    if (!guard.ok) return;

    const targets = resolveTargets(context.mentionedJids, context.argv);
    if (targets.length !== 1) {
      await context.reply('Mention exactly one person, for example `.resetwarns @user`.');
      return;
    }

    const target = targets[0] as string;
    const key = warningKey(guard.info, target);
    const cleared = await clearWarnings(context.chatJid, key);
    const remaining = await countActiveWarnings(context.chatJid, key);

    await context.reply(
      cleared === 0
        ? `${displayJid(target)} had no active warnings.`
        : `Cleared ${cleared} warning(s) for ${displayJid(target)}. Now ${remaining}.`,
      { mentions: mentionsFor([target]) },
    );
  },
};
