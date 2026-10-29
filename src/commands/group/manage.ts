/**
 * Participant management: add, remove, promote, demote.
 *
 * All four share one implementation because they differ only in the action
 * passed to WhatsApp and the wording of the confirmation. Each reports
 * per-participant outcomes, since WhatsApp fails these individually and a
 * blanket "done" would be a lie when two of three additions were refused.
 */
import {
  baseJid,
  describeParticipantFailure,
  findParticipant,
  isGroupAdmin,
  resolveTargets,
  type ParticipantAction,
} from '../../whatsapp/group.js';
import { displayJid, guardGroup, mentionsFor } from './common.js';
import type { Command, CommandContext } from '../types.js';

interface ActionSpec {
  action: ParticipantAction;
  /** Past tense, for the confirmation line. */
  past: string;
  /** Shown when no target could be parsed. */
  usageHint: string;
  /** Refuse to act on a group admin (removing/demoting one needs care). */
  protectAdmins: boolean;
}

async function runParticipantAction(context: CommandContext, spec: ActionSpec): Promise<void> {
  const guard = await guardGroup(context, { requireBotAdmin: true });
  if (!guard.ok || !guard.info || !context.group) return;

  const targets = resolveTargets(context.mentionedJids, context.argv);

  if (targets.length === 0) {
    await context.reply(spec.usageHint);
    return;
  }

  if (targets.length > 10) {
    await context.reply('That is more than 10 people at once. Please do it in smaller batches.');
    return;
  }

  // Never let the bot act on itself: removing or demoting itself would leave
  // the group unmanaged with no way back. A mention of the bot may carry
  // either of its ids, so match through the member list as well.
  const info = guard.info;
  const selfIds = [context.selfJid, context.selfLid]
    .filter((jid): jid is string => jid !== null)
    .map(baseJid);
  const self = findParticipant(info, ...selfIds);
  const isSelf = (jid: string): boolean =>
    selfIds.includes(jid) || (self !== undefined && findParticipant(info, jid) === self);
  const filtered = targets.filter((jid) => !isSelf(jid));
  if (filtered.length === 0) {
    await context.reply('I cannot run that command on myself.');
    return;
  }

  if (spec.protectAdmins && !context.isAdmin) {
    // Matched by either id, so typing an admin's number cannot get past this
    // in a group that lists its members by LID.
    const adminTargets = filtered.filter((jid) => isGroupAdmin(info, jid));
    if (adminTargets.length > 0) {
      await context.reply(
        `Cannot ${spec.action} a group admin. Demote them first if that is really what you want.`,
      );
      return;
    }
  }

  let results;
  try {
    results = await context.group.updateParticipants(context.chatJid, filtered, spec.action);
  } catch (cause) {
    context.log.warn({ err: String(cause), action: spec.action }, 'participant update failed');
    await context.reply('WhatsApp rejected that request. Please try again shortly.');
    return;
  }

  const succeeded = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);

  const lines: string[] = [];
  if (succeeded.length > 0) {
    lines.push(`*${spec.past}:* ${succeeded.map((r) => displayJid(r.jid)).join(', ')}`);
  }
  for (const failure of failed) {
    lines.push(
      `*Could not ${spec.action}* ${displayJid(failure.jid)} — ${
        failure.reason ?? describeParticipantFailure(failure.status, spec.action)
      }`,
    );
  }

  await context.reply(lines.join('\n'), { mentions: mentionsFor(succeeded.map((r) => r.jid)) });
}

export const addCommand: Command = {
  name: 'add',
  category: 'group',
  summary: 'Add someone to this group',
  usage: '.add <number>',
  examples: ['.add 254712345678'],
  async handler(context) {
    await runParticipantAction(context, {
      action: 'add',
      past: 'Added',
      usageHint: 'Give me a number to add, for example `.add 254712345678` (digits only, no +).',
      protectAdmins: false,
    });
  },
};

export const kickCommand: Command = {
  name: 'kick',
  aliases: ['remove'],
  category: 'group',
  summary: 'Remove someone from this group',
  usage: '.kick @user',
  examples: ['.kick @user', '.kick 254712345678'],
  async handler(context) {
    await runParticipantAction(context, {
      action: 'remove',
      past: 'Removed',
      usageHint: 'Mention the person to remove, for example `.kick @user`.',
      protectAdmins: true,
    });
  },
};

export const promoteCommand: Command = {
  name: 'promote',
  category: 'group',
  summary: 'Make someone a group admin',
  usage: '.promote @user',
  examples: ['.promote @user'],
  async handler(context) {
    await runParticipantAction(context, {
      action: 'promote',
      past: 'Promoted to admin',
      usageHint: 'Mention the person to promote, for example `.promote @user`.',
      protectAdmins: false,
    });
  },
};

export const demoteCommand: Command = {
  name: 'demote',
  category: 'group',
  summary: 'Remove someone as group admin',
  usage: '.demote @user',
  examples: ['.demote @user'],
  async handler(context) {
    await runParticipantAction(context, {
      action: 'demote',
      past: 'Demoted',
      usageHint: 'Mention the person to demote, for example `.demote @user`.',
      protectAdmins: false,
    });
  },
};
