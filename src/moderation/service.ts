/**
 * Moderation for one inbound group message: settings, silences, exemptions
 * and warnings from the database, the policy from `engine.ts`, and the
 * WhatsApp side supplied by the caller.
 */
import { logger, redactJid } from '../core/logger.js';
import { activeSilences, findGroupSettings, issueWarning } from '../db/repositories/groups.js';
import { isConfiguredAdmin } from '../db/repositories/members.js';
import { isGroupAdmin, type GroupInfo } from '../whatsapp/group.js';
import { reviewWithAi } from './ai-review.js';
import { enforce, evaluate, NoticeThrottle, type ModeratedMessage } from './engine.js';
import { SpamTracker } from './spam.js';

const log = logger.child({ component: 'moderation' });

const tracker = new SpamTracker();
const warningThrottle = new NoticeThrottle(60_000);
const notAdminThrottle = new NoticeThrottle(60 * 60_000);

export interface GroupMessageIO {
  /** Group metadata; cached by the caller, since this runs per message. */
  groupInfo(): Promise<GroupInfo>;
  /** Every id the bot is known by. */
  selfIds: string[];
  deleteMessage(): Promise<void>;
  removeSender(): Promise<boolean>;
  /** Post in the group; `{sender}` becomes a mention of the sender. */
  notify(text: string): Promise<void>;
}

/** True when the message broke a rule and was dealt with, so it must not run as a command. */
export async function moderateGroupMessage(message: ModeratedMessage, io: GroupMessageIO): Promise<boolean> {
  const [settings, silences] = await Promise.all([
    findGroupSettings(message.groupJid),
    activeSilences(message.groupJid),
  ]);
  if (!settings && silences.length === 0) return false;

  const senderIds = [message.senderJid, message.senderLid].filter((id): id is string => id !== null);

  const violation = await evaluate(message, {
    settings,
    silencedIds: new Set(silences.map((row) => row.memberJid)),
    tracker,
    isExempt: async () => {
      if (isConfiguredAdmin(message.senderJid)) return true;
      if (senderIds.some((id) => io.selfIds.includes(id))) return true;
      return isGroupAdmin(await io.groupInfo(), ...senderIds);
    },
    aiReview: reviewWithAi,
  });
  if (!violation) return false;

  const outcome = await enforce(
    message,
    violation,
    settings,
    {
      botIsAdmin: async () => isGroupAdmin(await io.groupInfo(), ...io.selfIds),
      deleteMessage: io.deleteMessage,
      issueWarning: (reason) =>
        issueWarning({
          groupJid: message.groupJid,
          targetJid: message.senderJid,
          issuedBy: 'system',
          reason,
        }),
      removeSender: io.removeSender,
      notify: io.notify,
      log,
    },
    { warningThrottle, notAdminThrottle },
  );

  log.info(
    {
      group: redactJid(message.groupJid),
      sender: redactJid(message.senderJid),
      rule: violation.rule,
      action: violation.action,
      outcome,
    },
    'message moderated',
  );
  return true;
}
