/**
 * Moderation commands: what the bot enforces on every message in a group.
 *
 * These only change settings. Enforcement lives in src/moderation and runs on
 * each incoming message. Group admins, platform administrators and the bot
 * itself are never moderated.
 */
import { isAiAvailable } from '../../ai/router.js';
import { env } from '../../config/env.js';
import {
  activeSilences,
  getGroupSettings,
  silenceMember,
  unsilenceMember,
  updateGroupSettings,
  type ModerationAction,
} from '../../db/repositories/groups.js';
import type { GroupSettingsRow } from '../../db/schema.js';
import {
  assessPromotion,
  findBannedWord,
  findLinks,
  normaliseDomain,
  PROMO_REVIEW_THRESHOLD,
  PROMO_THRESHOLD,
} from '../../moderation/detect.js';
import { DEFAULT_SPAM_LIMITS } from '../../moderation/spam.js';
import { findParticipant, isGroupAdmin, resolveTargets, type GroupInfo } from '../../whatsapp/group.js';
import { displayJid, guardGroup, mentionsFor } from './common.js';
import type { Command, CommandContext } from '../types.js';

const ACTIONS: ModerationAction[] = ['OFF', 'WARN', 'DELETE', 'REMOVE'];

/** "on" means delete: a rule that only warns rarely stops a spammer. */
export function parseAction(raw: string | undefined): ModerationAction | null {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  if (upper === 'ON') return 'DELETE';
  return (ACTIONS as string[]).includes(upper) ? (upper as ModerationAction) : null;
}

function describeAction(action: ModerationAction): string {
  switch (action) {
    case 'OFF':
      return 'off';
    case 'WARN':
      return 'warn only';
    case 'DELETE':
      return 'delete + warn';
    case 'REMOVE':
      return 'delete + warn, remove at the limit';
  }
}

function actionHelp(command: string): string[] {
  return [
    `• \`.${command} on\` or \`.${command} delete\` — delete the message and warn the sender`,
    `• \`.${command} remove\` — delete, warn, and remove the sender at the warning limit`,
    `• \`.${command} warn\` — only warn`,
    `• \`.${command} off\``,
  ];
}

function botIsAdmin(context: CommandContext, info: GroupInfo): boolean {
  return isGroupAdmin(info, context.selfJid, context.selfLid);
}

/** Deleting and removing need the bot to be an admin; say so now, not at the first offence. */
async function refuseIfBotCannotAct(
  context: CommandContext,
  info: GroupInfo,
  action: ModerationAction,
): Promise<boolean> {
  if ((action === 'DELETE' || action === 'REMOVE') && !botIsAdmin(context, info)) {
    await context.reply(
      'I need to be a group admin to delete messages or remove members. Make me an admin, ' +
        'then run this again — or use `warn` for now.',
    );
    return true;
  }
  return false;
}

// ── .antilink ────────────────────────────────────────────────────────────────

export const antilinkCommand: Command = {
  name: 'antilink',
  category: 'group',
  summary: 'Stop links to other groups, channels — or any link',
  usage: '.antilink <on|remove|warn|off> [invites|all]',
  examples: ['.antilink on', '.antilink on all', '.antilink allow who.int', '.antilink off'],
  async handler(context) {
    const guard = await guardGroup(context);
    if (!guard.ok || !guard.info) return;
    const [first, second] = context.argv;
    const sub = first?.toLowerCase();

    if (sub === 'allow' || sub === 'unallow') {
      const domain = second ? normaliseDomain(second) : null;
      if (!domain) {
        await context.reply('Give me a domain, for example `.antilink allow who.int`.');
        return;
      }
      const current = await getGroupSettings(context.chatJid);
      const allowed = new Set(current.allowedDomains);
      if (sub === 'allow') {
        if (allowed.size >= 50) {
          await context.reply('That is 50 allowed domains already. Remove one first.');
          return;
        }
        allowed.add(domain);
      } else {
        allowed.delete(domain);
      }
      await updateGroupSettings(context.chatJid, { allowedDomains: [...allowed].sort() });
      await context.reply(
        sub === 'allow'
          ? `Links to *${domain}* are always allowed here.`
          : `*${domain}* is no longer on the allowed list.`,
      );
      return;
    }

    const action = parseAction(first);
    if (!action) {
      const current = await getGroupSettings(context.chatJid);
      await context.reply(
        [
          `*Anti-link:* ${describeAction(current.antilink)}`,
          `*Applies to:* ${current.linkScope === 'ALL' ? 'all links' : 'invite links only'}`,
          current.allowedDomains.length > 0
            ? `*Always allowed:* ${current.allowedDomains.join(', ')}`
            : '*Always allowed:* none',
          '',
          ...actionHelp('antilink'),
          '',
          'Add `invites` or `all` to choose what counts:',
          '• `invites` (default) — WhatsApp groups and channels, wa.me, Telegram, Discord.',
          '  Job and scholarship links still work.',
          '• `all` — every link, except allowed domains.',
          '• `.antilink allow who.int` / `.antilink unallow who.int`',
        ].join('\n'),
      );
      return;
    }

    if (await refuseIfBotCannotAct(context, guard.info, action)) return;

    const scopeWord = second?.toLowerCase();
    const linkScope = scopeWord === 'all' ? 'ALL' : scopeWord === 'invites' ? 'INVITES' : undefined;
    const updated = await updateGroupSettings(context.chatJid, {
      antilink: action,
      ...(linkScope ? { linkScope } : {}),
    });
    await context.reply(
      action === 'OFF'
        ? 'Anti-link is off.'
        : `Anti-link: *${describeAction(action)}* for ${
            updated.linkScope === 'ALL' ? 'all links' : 'invite links'
          }. Admins are never moderated.`,
    );
  },
};

// ── .antipromo ───────────────────────────────────────────────────────────────

export const antipromoCommand: Command = {
  name: 'antipromo',
  aliases: ['antiad', 'antiads'],
  category: 'group',
  summary: 'Stop adverts, sales pitches and money schemes',
  usage: '.antipromo <on|remove|warn|off> · .antipromo ai <on|off>',
  examples: ['.antipromo on', '.antipromo ai on', '.antipromo off'],
  async handler(context) {
    const guard = await guardGroup(context);
    if (!guard.ok || !guard.info) return;
    const [first, second] = context.argv;

    if (first?.toLowerCase() === 'ai') {
      const on = second?.toLowerCase() === 'on';
      if (!on && second?.toLowerCase() !== 'off') {
        await context.reply('Use `.antipromo ai on` or `.antipromo ai off`.');
        return;
      }
      if (on && !isAiAvailable()) {
        await context.reply('The AI assistant is not configured on this server, so AI review cannot be turned on.');
        return;
      }
      await updateGroupSettings(context.chatJid, { aiReview: on });
      await context.reply(
        on
          ? 'AI review on: borderline posts the rules cannot decide are checked by the AI before anything is deleted.'
          : 'AI review off: only clear-cut adverts are acted on.',
      );
      return;
    }

    const action = parseAction(first);
    if (!action) {
      const current = await getGroupSettings(context.chatJid);
      await context.reply(
        [
          `*Anti-advert:* ${describeAction(current.antipromo)}`,
          `*AI review of borderline posts:* ${current.aiReview ? 'on' : 'off'}`,
          '',
          'Catches selling ("DM me", prices, "free delivery"), money schemes (forex, crypto,',
          '"earn daily", instant loans), follower-boosting and "join my channel" posts.',
          'Posts about scholarships, jobs, fellowships and deadlines are given the benefit of the doubt.',
          '',
          ...actionHelp('antipromo'),
          '• `.antipromo ai on` — let the AI decide borderline posts',
          '',
          'Try it safely with `.mod test <message>`.',
        ].join('\n'),
      );
      return;
    }

    if (await refuseIfBotCannotAct(context, guard.info, action)) return;
    await updateGroupSettings(context.chatJid, { antipromo: action });
    await context.reply(
      action === 'OFF' ? 'Anti-advert is off.' : `Anti-advert: *${describeAction(action)}*. Admins are never moderated.`,
    );
  },
};

// ── .antispam ────────────────────────────────────────────────────────────────

export const antispamCommand: Command = {
  name: 'antispam',
  aliases: ['antiflood'],
  category: 'group',
  summary: 'Stop flooding, repeated and cross-posted messages',
  usage: '.antispam <on|remove|warn|off>',
  examples: ['.antispam on', '.antispam off'],
  async handler(context) {
    const guard = await guardGroup(context);
    if (!guard.ok || !guard.info) return;
    const action = parseAction(context.argv[0]);

    if (!action) {
      const current = await getGroupSettings(context.chatJid);
      const limits = DEFAULT_SPAM_LIMITS;
      await context.reply(
        [
          `*Anti-spam:* ${describeAction(current.antispam)}`,
          '',
          'Acts on a member who:',
          `• sends more than ${limits.burstMax} messages in ${limits.burstWindowMs / 1000} seconds`,
          `• posts the same message ${limits.repeatMax} times within ${limits.repeatWindowMs / 60_000} minutes`,
          `• posts the same message in ${limits.crossGroupMax} or more groups within ${limits.repeatWindowMs / 60_000} minutes`,
          '',
          ...actionHelp('antispam'),
        ].join('\n'),
      );
      return;
    }

    if (await refuseIfBotCannotAct(context, guard.info, action)) return;
    await updateGroupSettings(context.chatJid, { antispam: action });
    await context.reply(
      action === 'OFF' ? 'Anti-spam is off.' : `Anti-spam: *${describeAction(action)}*. Admins are never moderated.`,
    );
  },
};

// ── .badword ─────────────────────────────────────────────────────────────────

const MAX_BANNED_WORDS = 100;

export const badwordCommand: Command = {
  name: 'badword',
  aliases: ['badwords', 'antibadword'],
  category: 'group',
  summary: 'Ban words and phrases',
  usage: '.badword add <word> · .badword del <word> · .badword list · .badword <on|remove|warn|off>',
  examples: ['.badword add fixed matches', '.badword on', '.badword list'],
  async handler(context) {
    const guard = await guardGroup(context);
    if (!guard.ok || !guard.info) return;
    const [first, ...rest] = context.argv;
    const sub = first?.toLowerCase();
    const current = await getGroupSettings(context.chatJid);

    if (sub === 'add' || sub === 'del' || sub === 'delete-word') {
      const phrase = rest.join(' ').trim().toLowerCase();
      if (phrase.length === 0 || phrase.length > 40) {
        await context.reply('Give me a word or short phrase (up to 40 characters), for example `.badword add fixed matches`.');
        return;
      }
      const words = new Set(current.bannedWords);
      if (sub === 'add') {
        if (words.size >= MAX_BANNED_WORDS) {
          await context.reply(`That is ${MAX_BANNED_WORDS} banned words already. Remove some first.`);
          return;
        }
        words.add(phrase);
      } else {
        words.delete(phrase);
      }
      await updateGroupSettings(context.chatJid, { bannedWords: [...words].sort() });
      const hint =
        sub === 'add' && current.antibadword === 'OFF' ? '\n\nBanned words are off — turn them on with `.badword on`.' : '';
      await context.reply(`${sub === 'add' ? 'Banned' : 'Unbanned'}: _${phrase}_ (${words.size} in total).${hint}`);
      return;
    }

    if (sub === 'list') {
      await context.reply(
        current.bannedWords.length === 0
          ? 'No banned words yet. Add one with `.badword add <word>`.'
          : `*Banned words (${current.bannedWords.length}):*\n${current.bannedWords.map((word) => `• ${word}`).join('\n')}`,
      );
      return;
    }

    if (sub === 'clear') {
      await updateGroupSettings(context.chatJid, { bannedWords: [] });
      await context.reply('All banned words cleared.');
      return;
    }

    const action = parseAction(first);
    if (!action) {
      await context.reply(
        [
          `*Banned words:* ${describeAction(current.antibadword)} — ${current.bannedWords.length} word(s)`,
          '',
          '• `.badword add <word or phrase>` / `.badword del <word>`',
          '• `.badword list` / `.badword clear`',
          ...actionHelp('badword'),
          '',
          'Whole words only, so "class" never matches "ass". Spaced-out spellings like "l.o.a.n" are caught.',
        ].join('\n'),
      );
      return;
    }

    if (await refuseIfBotCannotAct(context, guard.info, action)) return;
    await updateGroupSettings(context.chatJid, { antibadword: action });
    await context.reply(
      action === 'OFF' ? 'Banned words are off.' : `Banned words: *${describeAction(action)}*.`,
    );
  },
};

// ── .warnlimit ───────────────────────────────────────────────────────────────

export const warnLimitCommand: Command = {
  name: 'warnlimit',
  category: 'group',
  summary: 'Warnings before a member is removed',
  usage: '.warnlimit <1-10>',
  examples: ['.warnlimit 3', '.warnlimit 1'],
  async handler(context) {
    const guard = await guardGroup(context);
    if (!guard.ok) return;
    const raw = context.argv[0];
    const limit = raw && /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;

    if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
      const current = await getGroupSettings(context.chatJid);
      await context.reply(
        `*Warning limit:* ${current.warnLimit}\n\nSet it with \`.warnlimit <1-10>\`. ` +
          '`1` removes on the first offence, for rules set to `remove`.',
      );
      return;
    }

    await updateGroupSettings(context.chatJid, { warnLimit: limit });
    await context.reply(`Warning limit set to *${limit}*.`);
  },
};

// ── .silence / .unsilence ────────────────────────────────────────────────────

const MAX_SILENCE_MS = 30 * 24 * 60 * 60_000;

/** "30m", "2h", "1d" → milliseconds. */
export function parseDuration(token: string): number | null {
  const match = /^(\d{1,4})([mhd])$/i.exec(token);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'm').toLowerCase();
  const ms = amount * (unit === 'm' ? 60_000 : unit === 'h' ? 60 * 60_000 : 24 * 60 * 60_000);
  return ms > 0 && ms <= MAX_SILENCE_MS ? ms : null;
}

function formatWhen(date: Date): string {
  return date.toLocaleString('en-GB', {
    timeZone: env.TIMEZONE,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Every id a target is known by in this group. */
function identitiesOf(info: GroupInfo, target: string): string[] {
  const participant = findParticipant(info, target);
  return [
    ...new Set(
      [target, participant?.jid, participant?.phoneJid, participant?.lid].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  ];
}

export const silenceCommand: Command = {
  name: 'silence',
  aliases: ['shush'],
  category: 'group',
  summary: 'Delete everything a member posts, for a while',
  usage: '.silence @user [30m|2h|1d]',
  examples: ['.silence @user', '.silence @user 2h', '.silence @user 1d'],
  async handler(context) {
    const guard = await guardGroup(context, { requireBotAdmin: true });
    if (!guard.ok || !guard.info) return;
    const info = guard.info;

    const durationToken = context.argv.find((token) => /^\d{1,4}[mhd]$/i.test(token));
    const durationMs = durationToken ? parseDuration(durationToken) : 60 * 60_000;
    if (durationMs === null) {
      await context.reply('That duration is not valid. Use minutes, hours or days up to 30 days: `30m`, `2h`, `1d`.');
      return;
    }

    const targets = resolveTargets(context.mentionedJids, context.argv);
    if (targets.length === 0) {
      await context.reply('Mention who to silence, for example `.silence @user 2h`.');
      return;
    }

    const until = new Date(Date.now() + durationMs);
    const silenced: string[] = [];
    const refused: string[] = [];

    for (const target of targets.slice(0, 10)) {
      const ids = identitiesOf(info, target);
      const isSelf = ids.some((id) => id === context.selfJid || id === context.selfLid);
      if (isSelf || isGroupAdmin(info, ...ids)) {
        refused.push(target);
        continue;
      }
      await silenceMember(context.chatJid, ids, until, context.senderJid);
      silenced.push(target);
    }

    const lines: string[] = [];
    if (silenced.length > 0) {
      lines.push(
        `🔇 ${silenced.map(displayJid).join(', ')} silenced until ${formatWhen(until)}. ` +
          'Anything they post will be deleted.',
      );
    }
    if (refused.length > 0) {
      lines.push(`Admins cannot be silenced: ${refused.map(displayJid).join(', ')}. Demote them first.`);
    }
    await context.reply(lines.join('\n'), { mentions: mentionsFor(silenced) });
  },
};

export const unsilenceCommand: Command = {
  name: 'unsilence',
  aliases: ['unshush'],
  category: 'group',
  summary: 'Lift a silence early',
  usage: '.unsilence @user',
  examples: ['.unsilence @user'],
  async handler(context) {
    const guard = await guardGroup(context);
    if (!guard.ok || !guard.info) return;
    const info = guard.info;

    const targets = resolveTargets(context.mentionedJids, context.argv);
    if (targets.length === 0) {
      await context.reply('Mention who to unsilence, for example `.unsilence @user`.');
      return;
    }

    const lifted: string[] = [];
    for (const target of targets.slice(0, 10)) {
      if ((await unsilenceMember(context.chatJid, identitiesOf(info, target))) > 0) lifted.push(target);
    }
    await context.reply(
      lifted.length > 0 ? `🔈 ${lifted.map(displayJid).join(', ')} can post again.` : 'None of them were silenced.',
      { mentions: mentionsFor(lifted) },
    );
  },
};

export const silencedCommand: Command = {
  name: 'silenced',
  category: 'group',
  summary: 'Who is silenced, and until when',
  usage: '.silenced',
  async handler(context) {
    const guard = await guardGroup(context);
    if (!guard.ok || !guard.info) return;
    const info = guard.info;

    // One row per id; show each person once.
    const seen = new Map<string, Date>();
    for (const row of await activeSilences(context.chatJid)) {
      const person = findParticipant(info, row.memberJid)?.jid ?? row.memberJid;
      seen.set(person, row.until);
    }
    await context.reply(
      seen.size === 0
        ? 'Nobody is silenced in this group.'
        : `*Silenced (${seen.size}):*\n${[...seen]
            .map(([jid, until]) => `• ${displayJid(jid)} until ${formatWhen(until)}`)
            .join('\n')}`,
    );
  },
};

// ── .mod ─────────────────────────────────────────────────────────────────────

type ModerationPatch = Pick<
  GroupSettingsRow,
  | 'antilink'
  | 'antipromo'
  | 'antispam'
  | 'antibadword'
  | 'linkScope'
  | 'allowedDomains'
  | 'bannedWords'
  | 'aiReview'
  | 'warnLimit'
>;

function moderationPatch(settings: GroupSettingsRow): ModerationPatch {
  return {
    antilink: settings.antilink,
    antipromo: settings.antipromo,
    antispam: settings.antispam,
    antibadword: settings.antibadword,
    linkScope: settings.linkScope,
    allowedDomains: settings.allowedDomains,
    bannedWords: settings.bannedWords,
    aiReview: settings.aiReview,
    warnLimit: settings.warnLimit,
  };
}

async function overview(context: CommandContext, info: GroupInfo): Promise<void> {
  const settings = await getGroupSettings(context.chatJid);
  const silenced = new Set(
    (await activeSilences(context.chatJid)).map((row) => findParticipant(info, row.memberJid)?.jid ?? row.memberJid),
  );
  const admin = botIsAdmin(context, info);

  await context.reply(
    [
      `*Moderation — ${info.subject}*`,
      '',
      `🔗 Anti-link: ${describeAction(settings.antilink)}${
        settings.antilink === 'OFF' ? '' : settings.linkScope === 'ALL' ? ' (all links)' : ' (invite links)'
      }`,
      `📢 Anti-advert: ${describeAction(settings.antipromo)}${settings.aiReview ? ' (+ AI review)' : ''}`,
      `🌊 Anti-spam: ${describeAction(settings.antispam)}`,
      `🚫 Banned words: ${describeAction(settings.antibadword)} (${settings.bannedWords.length})`,
      `⚠️ Warnings before removal: ${settings.warnLimit}`,
      `🔇 Silenced members: ${silenced.size}`,
      admin ? '✅ I am an admin here.' : '❗ I am not an admin here, so I can only warn. Make me an admin.',
      '',
      '`.mod on` — recommended protection (delete + warn)',
      '`.mod strict` — the same, and remove at the warning limit',
      '`.mod off` — switch every rule off',
      '`.mod test <message>` — see what a message would trigger',
      '`.mod copy` — copy these settings to the other groups in this community',
      '',
      'Fine-tune with `.antilink`, `.antipromo`, `.antispam`, `.badword`, `.warnlimit`, `.silence`.',
    ].join('\n'),
  );
}

function testMessage(text: string, settings: GroupSettingsRow): string {
  const links = findLinks(text, settings.allowedDomains);
  const promo = assessPromotion(text);
  const banned = findBannedWord(text, settings.bannedWords);

  const linkHit = links.invites.length > 0 || (settings.linkScope === 'ALL' && links.external.length > 0);
  const promoVerdict =
    promo.score >= PROMO_THRESHOLD
      ? 'advert'
      : promo.score >= PROMO_REVIEW_THRESHOLD
        ? settings.aiReview
          ? 'borderline — the AI would decide'
          : 'borderline — left alone (AI review is off)'
        : 'fine';

  const verdict = (action: ModerationAction, hit: boolean): string =>
    action === 'OFF' ? 'rule off' : hit ? `would ${describeAction(action)}` : 'no action';

  return [
    '*Moderation test* (nothing was deleted)',
    '',
    `Links: ${links.invites.length} invite, ${links.external.length} other`,
    `Advert score: ${promo.score} of ${PROMO_THRESHOLD} — ${promoVerdict}`,
    promo.reasons.length > 0 ? `Signals: ${promo.reasons.join(', ')}` : 'Signals: none',
    `Banned word: ${banned ?? 'none'}`,
    '',
    `🔗 Anti-link: ${verdict(settings.antilink, linkHit)}`,
    `📢 Anti-advert: ${verdict(settings.antipromo, promo.score >= PROMO_THRESHOLD)}`,
    `🚫 Banned words: ${verdict(settings.antibadword, banned !== null)}`,
    '🌊 Anti-spam depends on timing, so it cannot be tested with one message.',
    '',
    '_Admins are never moderated, so post as a regular member to see it for real._',
  ].join('\n');
}

async function copyToCommunity(context: CommandContext, info: GroupInfo): Promise<void> {
  if (!context.group) return;
  const groups = await context.group.listGroups();
  const here = groups.find((group) => group.jid === info.jid) ?? info;
  const community = here.communityJid ?? null;
  if (!community) {
    await context.reply('This group is not part of a WhatsApp community, so there is nothing to copy to.');
    return;
  }

  const patch = moderationPatch(await getGroupSettings(context.chatJid));
  const copied: string[] = [];
  const warnOnly: string[] = [];
  const skipped: string[] = [];

  for (const group of groups) {
    if (group.jid === here.jid || group.communityJid !== community) continue;
    // The caller must be an admin of each group they change, not just this one.
    if (!context.isAdmin && !isGroupAdmin(group, context.senderJid, context.senderLid)) {
      skipped.push(group.subject);
      continue;
    }
    await updateGroupSettings(group.jid, patch);
    (isGroupAdmin(group, context.selfJid, context.selfLid) ? copied : warnOnly).push(group.subject);
  }

  const lines = ['*Moderation settings copied*'];
  if (copied.length > 0) lines.push('', `✅ ${copied.join(', ')}`);
  if (warnOnly.length > 0) {
    lines.push('', `❗ Copied, but I am not an admin there, so I can only warn: ${warnOnly.join(', ')}`);
  }
  if (skipped.length > 0) lines.push('', `⏭️ Skipped — you are not an admin there: ${skipped.join(', ')}`);
  if (copied.length + warnOnly.length + skipped.length === 0) {
    lines.push('', 'I am not in any other group of this community.');
  }
  await context.reply(lines.join('\n'));
}

export const modCommand: Command = {
  name: 'mod',
  aliases: ['moderation'],
  category: 'group',
  summary: 'Moderation overview, presets, test and copy',
  usage: '.mod [on|strict|off|test <message>|copy]',
  examples: ['.mod', '.mod on', '.mod test DM me for cheap loans', '.mod copy'],
  async handler(context) {
    const guard = await guardGroup(context);
    if (!guard.ok || !guard.info) return;
    const info = guard.info;
    const sub = context.argv[0]?.toLowerCase();

    if (sub === 'on' || sub === 'strict') {
      const action: ModerationAction = sub === 'strict' ? 'REMOVE' : 'DELETE';
      if (await refuseIfBotCannotAct(context, info, action)) return;
      const current = await getGroupSettings(context.chatJid);
      await updateGroupSettings(context.chatJid, {
        antilink: action,
        antipromo: action,
        antispam: action,
        ...(current.bannedWords.length > 0 ? { antibadword: action } : {}),
      });
      await context.reply(
        [
          `*Moderation ${sub === 'strict' ? 'strict' : 'on'}* — ${describeAction(action)}:`,
          `• invite links to other groups and channels${current.linkScope === 'ALL' ? ' (and all other links)' : ''}`,
          '• adverts, sales pitches and money schemes',
          '• flooding, repeated and cross-posted messages',
          current.bannedWords.length > 0 ? '• banned words' : '• banned words: add some with `.badword add <word>`',
          '',
          `Warnings before removal: ${current.warnLimit}. Admins are never moderated.`,
          'Check what a post would trigger with `.mod test <message>`.',
        ].join('\n'),
      );
      return;
    }

    if (sub === 'off') {
      await updateGroupSettings(context.chatJid, {
        antilink: 'OFF',
        antipromo: 'OFF',
        antispam: 'OFF',
        antibadword: 'OFF',
      });
      await context.reply('All moderation rules are off. Silences stay until they expire (`.silenced`).');
      return;
    }

    if (sub === 'test') {
      const text = context.args.replace(/^\S+\s*/, '');
      if (text.length === 0) {
        await context.reply('Give me a message to test, for example `.mod test DM me for cheap loans`.');
        return;
      }
      await context.reply(testMessage(text, await getGroupSettings(context.chatJid)));
      return;
    }

    if (sub === 'copy') {
      await copyToCommunity(context, info);
      return;
    }

    await overview(context, info);
  },
};
