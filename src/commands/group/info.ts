/**
 * `.groupinfo` — a summary of the current group.
 *
 * Shows counts and settings, never a participant list: printing every member's
 * number into a chat log is exactly the kind of casual exposure this platform
 * avoids.
 */
import { getGroupSettings } from '../../db/repositories/groups.js';
import { guardGroup } from './common.js';
import type { Command } from '../types.js';

export const groupInfoCommand: Command = {
  name: 'groupinfo',
  aliases: ['ginfo'],
  category: 'group',
  summary: 'Show this group’s details and settings',
  usage: '.groupinfo',
  exemptFromRateLimit: true,
  async handler(context) {
    // Readable by any member: it exposes nothing sensitive.
    const guard = await guardGroup(context, { requireCallerAdmin: false });
    if (!guard.ok || !guard.info) return;

    const info = guard.info;
    const settings = await getGroupSettings(context.chatJid);
    const admins = info.participants.filter((p) => p.isAdmin || p.isSuperAdmin).length;

    const lines = [
      `*${info.subject}*`,
      '',
      `Members: ${info.participants.length}`,
      `Admins: ${admins}`,
      `Messaging: ${info.announceOnly ? 'admins only' : 'everyone'}`,
      `Group info: ${info.locked ? 'admins only' : 'everyone'}`,
      '',
      '*Moderation*',
      `Anti-link: ${settings.antilink}`,
      `Anti-advert: ${settings.antipromo}`,
      `Anti-spam: ${settings.antispam}`,
      `Banned words: ${settings.antibadword} (${settings.bannedWords.length})`,
      `Warning limit: ${settings.warnLimit}`,
      `Welcome messages: ${settings.welcomeEnabled ? 'on' : 'off'}`,
    ];

    if (info.createdAt) {
      lines.push(
        '',
        `Created: ${info.createdAt.toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        })}`,
      );
    }

    await context.reply(lines.join('\n'));
  },
};
