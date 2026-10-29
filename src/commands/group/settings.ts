/**
 * Group settings: who may post, who may edit info, welcome messages.
 * Moderation rules (antilink and the rest) live in moderation.ts.
 */
import { getGroupSettings, updateGroupSettings } from '../../db/repositories/groups.js';
import { DEFAULT_WELCOME, renderWelcome } from '../../groups/welcome.js';
import { guardGroup } from './common.js';
import type { Command } from '../types.js';

export const openCommand: Command = {
  name: 'open',
  aliases: ['unmute'],
  category: 'group',
  summary: 'Let everyone send messages',
  usage: '.open',
  async handler(context) {
    const guard = await guardGroup(context, { requireBotAdmin: true });
    if (!guard.ok || !context.group) return;
    await context.group.updateSetting(context.chatJid, 'not_announcement');
    await context.reply('Group opened. Everyone can send messages.');
  },
};

export const closeCommand: Command = {
  name: 'close',
  aliases: ['mute'],
  category: 'group',
  summary: 'Only admins can send messages',
  usage: '.close',
  async handler(context) {
    const guard = await guardGroup(context, { requireBotAdmin: true });
    if (!guard.ok || !context.group) return;
    await context.group.updateSetting(context.chatJid, 'announcement');
    await context.reply('Group closed. Only admins can send messages.');
  },
};

export const lockCommand: Command = {
  name: 'lock',
  category: 'group',
  summary: 'Only admins can edit group info',
  usage: '.lock',
  async handler(context) {
    const guard = await guardGroup(context, { requireBotAdmin: true });
    if (!guard.ok || !context.group) return;
    await context.group.updateSetting(context.chatJid, 'locked');
    await context.reply('Group info locked. Only admins can change it.');
  },
};

export const unlockCommand: Command = {
  name: 'unlock',
  category: 'group',
  summary: 'Let everyone edit group info',
  usage: '.unlock',
  async handler(context) {
    const guard = await guardGroup(context, { requireBotAdmin: true });
    if (!guard.ok || !context.group) return;
    await context.group.updateSetting(context.chatJid, 'unlocked');
    await context.reply('Group info unlocked. Everyone can change it.');
  },
};

export const welcomeCommand: Command = {
  name: 'welcome',
  category: 'group',
  summary: 'Greet people who join',
  usage: '.welcome <on|off|set <message>|test|reset>',
  examples: [
    '.welcome on',
    '.welcome set Welcome to {group}, {name}! Introduce yourself 👋',
    '.welcome test',
    '.welcome off',
  ],
  async handler(context) {
    const guard = await guardGroup(context);
    if (!guard.ok || !guard.info) return;

    const [sub, ...rest] = context.argv;
    const mode = sub?.toLowerCase();

    if (mode === 'on' || mode === 'off') {
      await updateGroupSettings(context.chatJid, { welcomeEnabled: mode === 'on' });
      await context.reply(
        mode === 'on'
          ? 'Welcome messages on. New members are greeted within a few seconds of joining. Preview it with `.welcome test`.'
          : 'Welcome messages off.',
      );
      return;
    }

    if (mode === 'set') {
      // Taken from the raw text so line breaks in the message survive.
      const message = context.args.replace(/^\S+\s*/, '').trim();
      if (message.length === 0) {
        await context.reply('Give me the message, for example `.welcome set Welcome to {group}, {name}!`');
        return;
      }
      if (message.length > 600) {
        await context.reply('That message is too long. Keep it under 600 characters.');
        return;
      }
      await updateGroupSettings(context.chatJid, { welcomeMessage: message, welcomeEnabled: true });
      await context.reply('Welcome message saved and switched on. Preview it with `.welcome test`.');
      return;
    }

    if (mode === 'reset') {
      await updateGroupSettings(context.chatJid, { welcomeMessage: null });
      await context.reply('Back to the standard welcome message. Preview it with `.welcome test`.');
      return;
    }

    const current = await getGroupSettings(context.chatJid);

    if (mode === 'test') {
      // Tags the admin who asked, exactly as a newcomer would be tagged.
      const preview = renderWelcome(current.welcomeMessage, {
        tags: [`@${context.senderJid.split('@')[0] ?? ''}`],
        group: guard.info.subject,
      });
      await context.reply(
        `${preview}\n\n_Preview — welcome messages are ${current.welcomeEnabled ? 'on' : 'off'} in this group._`,
        { mentions: [context.senderJid] },
      );
      return;
    }

    await context.reply(
      [
        `*Welcome messages:* ${current.welcomeEnabled ? 'on' : 'off'}`,
        '',
        current.welcomeMessage ? `_${current.welcomeMessage}_` : `_Standard message:_\n${DEFAULT_WELCOME}`,
        '',
        '• `.welcome on` / `.welcome off`',
        '• `.welcome set <message>` — `{name}` tags the newcomers, `{group}` is the group name',
        '• `.welcome test` — preview it',
        '• `.welcome reset` — back to the standard message',
        '',
        'People joining together are welcomed in one message, at most one a minute.',
      ].join('\n'),
    );
  },
};

