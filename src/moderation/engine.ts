/**
 * Group moderation: decide whether a message breaks a group's rules, and act.
 *
 * `evaluate` decides and `enforce` acts; both take their I/O as arguments so
 * the whole policy is unit-tested without WhatsApp or a database.
 *
 * Who is never moderated: group admins, platform administrators and the bot
 * itself. Those checks happen only once a message actually breaks a rule, so
 * ordinary chatter never costs a group-metadata lookup.
 */
import type { Logger } from '../core/logger.js';
import type { ModerationAction } from '../db/repositories/groups.js';
import type { GroupSettingsRow } from '../db/schema.js';
import {
  assessPromotion,
  findBannedWord,
  findLinks,
  PROMO_REVIEW_THRESHOLD,
  PROMO_THRESHOLD,
} from './detect.js';
import { describeSpam, type SpamTracker } from './spam.js';

export type Rule = 'silence' | 'antilink' | 'antibadword' | 'antispam' | 'antipromo';

export type ModerationSettings = Pick<
  GroupSettingsRow,
  | 'antilink'
  | 'antibadword'
  | 'antipromo'
  | 'antispam'
  | 'linkScope'
  | 'allowedDomains'
  | 'bannedWords'
  | 'aiReview'
  | 'warnLimit'
>;

export interface Violation {
  rule: Rule;
  action: ModerationAction;
  /** Shown to the member, so it never repeats the offending content. */
  reason: string;
}

export interface ModeratedMessage {
  groupJid: string;
  /** Phone JID when known: the stable key for warnings and spam tracking. */
  senderJid: string;
  senderLid: string | null;
  /** Empty for media without a caption. */
  text: string;
  forwardingScore: number;
}

export interface EvaluateDeps {
  settings: ModerationSettings | null;
  /** Every id currently silenced in this group. */
  silencedIds: ReadonlySet<string>;
  tracker: SpamTracker;
  /** Group admin, platform administrator or the bot. Called at most once. */
  isExempt(): Promise<boolean>;
  /** A second opinion on borderline adverts; null when undecided. */
  aiReview?: (text: string) => Promise<boolean | null>;
  now?: number;
}

const SEVERITY: Record<ModerationAction, number> = { OFF: 0, WARN: 1, DELETE: 2, REMOVE: 3 };

/** The violation to act on, or null. When several rules fire, the strictest wins. */
export async function evaluate(message: ModeratedMessage, deps: EvaluateDeps): Promise<Violation | null> {
  const { settings } = deps;
  const ids = [message.senderJid, message.senderLid].filter((id): id is string => id !== null);

  if (ids.some((id) => deps.silencedIds.has(id))) {
    return (await deps.isExempt())
      ? null
      : { rule: 'silence', action: 'DELETE', reason: 'you are silenced in this group' };
  }
  if (!settings) return null;

  const candidates: Violation[] = [];
  const text = message.text;

  // Recorded for every message, so flooding is seen even when it starts with
  // harmless ones.
  if (settings.antispam !== 'OFF' && text.length > 0) {
    const kind = deps.tracker.record(message.groupJid, message.senderJid, text, deps.now);
    if (kind) candidates.push({ rule: 'antispam', action: settings.antispam, reason: describeSpam(kind) });
  }

  if (settings.antilink !== 'OFF' && text.length > 0) {
    const links = findLinks(text, settings.allowedDomains);
    if (links.invites.length > 0) {
      candidates.push({
        rule: 'antilink',
        action: settings.antilink,
        reason: 'links to other groups, channels or private chats are not allowed here',
      });
    } else if (settings.linkScope === 'ALL' && links.external.length > 0) {
      candidates.push({ rule: 'antilink', action: settings.antilink, reason: 'links are not allowed here' });
    }
  }

  if (settings.antibadword !== 'OFF' && findBannedWord(text, settings.bannedWords) !== null) {
    candidates.push({
      rule: 'antibadword',
      action: settings.antibadword,
      reason: 'that language is not allowed here',
    });
  }

  let borderlineAdvert = false;
  if (settings.antipromo !== 'OFF' && text.length > 0) {
    const { score } = assessPromotion(text, { forwardingScore: message.forwardingScore });
    if (score >= PROMO_THRESHOLD) {
      candidates.push({
        rule: 'antipromo',
        action: settings.antipromo,
        reason: 'adverts and promotions are not allowed here',
      });
    } else if (score >= PROMO_REVIEW_THRESHOLD && settings.aiReview && deps.aiReview) {
      borderlineAdvert = true;
    }
  }

  if (candidates.length === 0 && !borderlineAdvert) return null;

  // Exemption before any AI call: an admin's post never costs a review.
  if (await deps.isExempt()) return null;

  if (borderlineAdvert && candidates.length === 0 && deps.aiReview) {
    const isAdvert = await deps.aiReview(text);
    if (isAdvert === true) {
      candidates.push({
        rule: 'antipromo',
        action: settings.antipromo,
        reason: 'adverts and promotions are not allowed here',
      });
    }
  }

  // Strictest first; ties keep the order above, which runs from most to least
  // certain.
  return candidates.reduce<Violation | null>(
    (best, next) => (best === null || SEVERITY[next.action] > SEVERITY[best.action] ? next : best),
    null,
  );
}

// ── Enforcement ──────────────────────────────────────────────────────────────

export interface EnforceIO {
  botIsAdmin(): Promise<boolean>;
  deleteMessage(): Promise<void>;
  /** Record a warning; returns the sender's active warning count. */
  issueWarning(reason: string): Promise<number>;
  removeSender(): Promise<boolean>;
  /** Post in the group, tagging the sender. `{sender}` is replaced with the tag. */
  notify(text: string): Promise<void>;
  log: Logger;
}

/** Remembers recent warnings and notices so the bot does not flood the group itself. */
export class NoticeThrottle {
  private readonly last = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  /** True if `key` fired within the window; otherwise records it and returns false. */
  hit(key: string, now = Date.now()): boolean {
    const previous = this.last.get(key);
    if (previous !== undefined && now - previous < this.windowMs) return true;
    if (this.last.size > 5000) this.last.clear();
    this.last.set(key, now);
    return false;
  }
}

export interface EnforceOptions {
  /** One warning per member per rule within this window: a flood of ten is one offence. */
  warningThrottle: NoticeThrottle;
  /** One "I am not an admin" notice per group within this window. */
  notAdminThrottle: NoticeThrottle;
  now?: number;
}

export type EnforcementOutcome = 'deleted' | 'warned' | 'removed' | 'throttled' | 'not-admin';

export async function enforce(
  message: ModeratedMessage,
  violation: Violation,
  settings: Pick<ModerationSettings, 'warnLimit'> | null,
  io: EnforceIO,
  options: EnforceOptions,
): Promise<EnforcementOutcome> {
  const needsAdmin = violation.action === 'DELETE' || violation.action === 'REMOVE';
  let action = violation.action;

  if (needsAdmin && !(await io.botIsAdmin())) {
    if (!options.notAdminThrottle.hit(message.groupJid, options.now)) {
      await io.notify(
        'Moderation is on in this group, but I am not an admin, so I cannot delete messages. ' +
          'Please make me an admin.',
      );
    }
    // A silence can only be enforced by deleting; warning would be noise.
    if (violation.rule === 'silence') return 'not-admin';
    action = 'WARN';
  }

  if (action === 'DELETE' || action === 'REMOVE') await io.deleteMessage();
  if (violation.rule === 'silence') return 'deleted';

  const throttleKey = `${message.groupJid}|${message.senderJid}|${violation.rule}`;
  if (options.warningThrottle.hit(throttleKey, options.now)) {
    return action === 'WARN' ? 'throttled' : 'deleted';
  }

  const limit = settings?.warnLimit ?? 3;
  const count = await io.issueWarning(`automatic (${violation.rule}): ${violation.reason}`);

  if (action === 'REMOVE' && count >= limit) {
    const removed = await io.removeSender();
    if (removed) {
      await io.notify(`{sender} was removed after ${count} warnings: ${violation.reason}.`);
      return 'removed';
    }
    io.log.warn({ rule: violation.rule }, 'moderation could not remove a member');
  }

  const tail =
    action === 'REMOVE' && count < limit
      ? ` At ${limit} you will be removed.`
      : count >= limit
        ? ' That is the limit; an admin may remove you.'
        : '';
  await io.notify(`⚠️ {sender}, ${violation.reason}. Warning ${count}/${limit}.${tail}`);
  return action === 'WARN' ? 'warned' : 'deleted';
}
