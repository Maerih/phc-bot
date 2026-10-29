/**
 * Shared guards for group commands.
 *
 * Every group command needs the same three checks, and getting any of them
 * wrong is a security bug rather than a papercut:
 *
 *   1. Are we actually in a group?
 *   2. Is the caller a group admin (or a platform administrator)?
 *   3. Is the bot itself an admin, so the action can even succeed?
 *
 * Doing this once, here, means a new group command cannot forget one.
 */
import type { CommandContext } from '../types.js';
import { baseJid, findParticipant, isGroupAdmin, type GroupInfo } from '../../whatsapp/group.js';

export interface GroupGuardResult {
  ok: boolean;
  info?: GroupInfo;
}

export interface GuardOptions {
  /** Require the bot to be an admin too. Needed for participant changes. */
  requireBotAdmin?: boolean;
  /** Require the caller to be a group admin. Default true. */
  requireCallerAdmin?: boolean;
}

/**
 * Run the standard checks, replying with the reason on failure.
 *
 * Returns the group metadata on success so the caller does not fetch it twice.
 */
export async function guardGroup(
  context: CommandContext,
  options: GuardOptions = {},
): Promise<GroupGuardResult> {
  const requireCallerAdmin = options.requireCallerAdmin ?? true;

  if (!context.isGroup) {
    await context.reply('That command only works inside a group.');
    return { ok: false };
  }

  if (!context.group) {
    await context.reply('Group actions are unavailable right now. Please try again shortly.');
    return { ok: false };
  }

  let info: GroupInfo;
  try {
    info = await context.group.info(context.chatJid);
  } catch (cause) {
    context.log.warn({ err: String(cause) }, 'could not read group metadata');
    await context.reply('Could not read this group. Please try again shortly.');
    return { ok: false };
  }

  // A platform administrator can act anywhere; otherwise the caller must be an
  // admin of this specific group.
  if (
    requireCallerAdmin &&
    !context.isAdmin &&
    !isGroupAdmin(info, context.senderJid, context.senderLid)
  ) {
    await context.reply('Only group admins can use that command.');
    return { ok: false };
  }

  if (options.requireBotAdmin) {
    if (!isGroupAdmin(info, context.selfJid, context.selfLid)) {
      // Says whether the bot found itself at all: "not found" means an identity
      // mismatch to fix in code, "found" means it genuinely needs promoting.
      context.log.info(
        {
          foundSelf: findParticipant(info, context.selfJid, context.selfLid) !== undefined,
          hasSelfLid: context.selfLid !== null,
        },
        'bot is not a group admin',
      );
      await context.reply(
        'I need to be a group admin to do that. Please promote me and try again.',
      );
      return { ok: false };
    }
  }

  return { ok: true, info };
}

/** Render a JID as a readable handle without printing the full number. */
export function displayJid(jid: string): string {
  const user = baseJid(jid).split('@')[0] ?? '';
  if (user.length <= 4) return `@${user}`;
  return `@${user.slice(0, 3)}***${user.slice(-3)}`;
}

/** Mention payload for a reply that should tag people. */
export function mentionsFor(jids: string[]): string[] {
  return jids.map(baseJid);
}
