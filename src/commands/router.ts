/**
 * Command routing.
 *
 * Takes an inbound message and decides what, if anything, to run. Deliberately
 * transport-agnostic: it receives plain text and a pair of JIDs and returns
 * through callbacks, so it can be unit-tested with no WhatsApp socket and
 * reused by any future surface.
 *
 * Security notes:
 *  - admin authorisation is checked here, against ADMIN_NUMBERS, before a
 *    handler runs. A command is never trusted because of its name.
 *  - rate limiting is per member and persisted, so a flood cannot be reset by
 *    restarting the process.
 *  - message text is never logged; only the resolved command name is.
 */
import { env } from '../config/env.js';
import { TtlCache } from '../core/cache.js';
import { logger, redactJid } from '../core/logger.js';
import { consumeRateToken, isConfiguredAdmin, touchMember } from '../db/repositories/members.js';
import { findCommand } from './registry.js';
import type { GroupActions } from '../whatsapp/group.js';
import type { CommandContext, MemberSession, ReplyOptions } from './types.js';

const log = logger.child({ component: 'router' });

/** Conversational state per chat. In-process for Phase 1; Redis later. */
const sessions = new TtlCache<MemberSession>(30 * 60 * 1000, 2000);

export interface InboundMessage {
  chatJid: string;
  senderJid: string;
  /** The sender's anonymous id (`…@lid`), when known. */
  senderLid?: string | null;
  isGroup: boolean;
  text: string;
  /** JIDs mentioned in the message, if any. */
  mentionedJids?: string[];
}

export interface Transport {
  sendText(chatJid: string, text: string, options?: ReplyOptions): Promise<void>;
  react(chatJid: string, emoji: string): Promise<void>;
  /** Present only when the transport can administer groups. */
  group?: GroupActions;
  /** The bot's own JID, when known. */
  selfJid?: string | null;
  /** The bot's own anonymous id (`…@lid`), when known. */
  selfLid?: string | null;
}

/** A message is a command only when it starts with the configured prefix. */
export function parseInvocation(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(env.COMMAND_PREFIX)) return null;

  const withoutPrefix = trimmed.slice(env.COMMAND_PREFIX.length).trim();
  if (withoutPrefix.length === 0) return null;

  const match = /^(\S+)\s*([\s\S]*)$/.exec(withoutPrefix);
  if (!match) return null;

  return { name: (match[1] ?? '').toLowerCase(), args: (match[2] ?? '').trim() };
}

/**
 * Handle one inbound message.
 *
 * Returns true when a command ran. Unrecognised commands get a short nudge;
 * ordinary conversation is ignored entirely, which matters in a group chat
 * where the bot must not interject. (Phase 3 adds natural-language intent
 * detection for direct messages.)
 */
export async function handleMessage(message: InboundMessage, transport: Transport): Promise<boolean> {
  const invocation = parseInvocation(message.text);
  if (!invocation) return false;

  const command = findCommand(invocation.name);
  if (!command) {
    // Only nudge in direct chats: an unknown-command reply to every stray "."
    // in a busy group would be noise.
    if (!message.isGroup) {
      await transport.sendText(
        message.chatJid,
        `Unknown command \`${env.COMMAND_PREFIX}${invocation.name}\`. Run \`${env.COMMAND_PREFIX}help\` to see what is available.`,
      );
    }
    return false;
  }

  const commandLog = log.child({ command: command.name, sender: redactJid(message.senderJid) });

  let member;
  try {
    member = await touchMember(message.senderJid);
  } catch (cause) {
    commandLog.error({ err: cause instanceof Error ? cause.message : String(cause) }, 'member lookup failed');
    await transport.sendText(message.chatJid, '⚠️ The service is briefly unavailable. Please try again shortly.');
    return false;
  }

  if (member.isBlocked) {
    commandLog.info('ignoring blocked member');
    return false;
  }

  // Authorisation before anything else a handler might do.
  const isAdmin = member.isAdmin && isConfiguredAdmin(message.senderJid);
  if (command.adminOnly && !isAdmin) {
    // Same reply as an unknown command: do not confirm that the command exists.
    await transport.sendText(
      message.chatJid,
      `Unknown command \`${env.COMMAND_PREFIX}${invocation.name}\`. Run \`${env.COMMAND_PREFIX}help\` to see what is available.`,
    );
    commandLog.warn('rejected admin command from non-admin');
    return false;
  }

  if (!command.exemptFromRateLimit) {
    const allowed = await consumeRateToken(member.id).catch(() => true);
    if (!allowed) {
      await transport.sendText(
        message.chatJid,
        '🛑 You have sent a lot of requests in a short time. Please wait a minute and try again.',
      );
      commandLog.info('rate limited');
      return false;
    }
  }

  const sessionKey = `${message.chatJid}|${message.senderJid}`;

  const context: CommandContext = {
    chatJid: message.chatJid,
    senderJid: message.senderJid,
    senderLid: message.senderLid ?? null,
    isGroup: message.isGroup,
    mentionedJids: message.mentionedJids ?? [],
    selfJid: transport.selfJid ?? null,
    selfLid: transport.selfLid ?? null,
    group: transport.group ?? null,
    args: invocation.args,
    argv: invocation.args.split(/\s+/).filter((part) => part.length > 0),
    invokedAs: invocation.name,
    member,
    isAdmin,
    log: commandLog,
    reply: (text, options) => transport.sendText(message.chatJid, text, options),
    react: (emoji) => transport.react(message.chatJid, emoji),
    getSession: () => sessions.get(sessionKey),
    setSession: (session) => sessions.set(sessionKey, session),
    clearSession: () => sessions.delete(sessionKey),
  };

  const startedAt = Date.now();
  try {
    await command.handler(context);
    commandLog.info({ durationMs: Date.now() - startedAt }, 'command handled');
    return true;
  } catch (cause) {
    // A handler throwing must never take the bot down or leave the member
    // staring at silence.
    commandLog.error(
      { err: cause instanceof Error ? cause.stack : String(cause), durationMs: Date.now() - startedAt },
      'command handler threw',
    );
    await transport
      .sendText(message.chatJid, '⚠️ Something went wrong running that command. Please try again.')
      .catch(() => undefined);
    return false;
  }
}

/** Exposed for tests. */
export function clearAllSessions(): void {
  sessions.clear();
}
