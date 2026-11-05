/**
 * Where WhatsApp hands private conversations and documents to the career
 * assistant, and the daily privacy clean-up.
 */
import { logger } from '../core/logger.js';
import { touchMember } from '../db/repositories/members.js';
import type { ConversationHandler } from '../commands/router.js';
import type { DocumentHandler } from '../whatsapp/client.js';
import { assistantAvailable, handleDocument, runAssistant } from './agent.js';
import { openSession } from './dm-mode.js';
import { careerMessenger } from './messenger.js';
import { purgeInactive } from './store.js';

const log = logger.child({ component: 'career' });

export const converse: ConversationHandler = async ({ message, transport, member, isAdmin }) => {
  if (!assistantAvailable()) return;
  if (!message.isGroup) openSession(message.chatJid);
  await transport.busy?.(message.chatJid);
  await runAssistant({
    memberId: member.id,
    chatJid: message.chatJid,
    isAdmin,
    text: message.text.slice(0, 4000),
    reply: (text) => transport.sendText(message.chatJid, text),
  });
};

export const receiveDocument: DocumentHandler = async ({ senderJid, chatJid, pushName, bytes, mime, fileName }) => {
  if (!assistantAvailable()) return;
  const member = await touchMember(senderJid, pushName);
  if (member.isBlocked) return;
  openSession(chatJid);
  await handleDocument(
    { memberId: member.id, chatJid, isAdmin: false, text: '', reply: async (text) => careerMessenger()?.sendText(chatJid, text) },
    bytes,
    mime,
    fileName,
  );
};

let retentionTimer: ReturnType<typeof setInterval> | null = null;

/** Delete career data of members inactive for 12 months; checked twice a day. */
export function startRetention(): void {
  if (retentionTimer) return;
  const run = (): void => {
    purgeInactive()
      .then((count) => count > 0 && log.info({ members: count }, 'deleted career data of inactive members'))
      .catch((cause) => log.warn({ err: String(cause) }, 'retention clean-up failed'));
  };
  setTimeout(run, 60_000).unref();
  retentionTimer = setInterval(run, 12 * 3_600_000);
  retentionTimer.unref();
}
