/**
 * Owner switches for how the bot's own account behaves, and the contact list.
 * Platform administrators only. Every switch starts off.
 */
import { vcards } from './vcard.js';
import { connection as sql } from '../../db/client.js';
import { careerMessenger } from '../../career/messenger.js';
import { aiStatus, endSession, openSession, setAiMode, setChatStopped } from '../../career/dm-mode.js';
import { getSetting, setSetting } from '../../career/store.js';
import { forgetSwitch } from '../../whatsapp/client.js';
import type { Command } from '../types.js';

interface Switch {
  name: string;
  aliases: string[];
  summary: string;
  on: string;
  off: string;
}

const SWITCHES: Switch[] = [
  { name: 'autoview', aliases: ['autoviewstatus'], summary: 'View contacts’ statuses automatically', on: 'Statuses will be viewed automatically.', off: 'Statuses will no longer be viewed automatically.' },
  { name: 'autolike', aliases: ['autolikestatus'], summary: 'Like (💚) contacts’ statuses automatically', on: 'Statuses will be liked with 💚 automatically.', off: 'Automatic status likes are off.' },
  { name: 'alwaysonline', aliases: ['online'], summary: 'Show the bot as online all the time', on: 'The bot will show as online. (WhatsApp may treat a number that is always online as automated.)', off: 'The bot no longer shows as always online.' },
  { name: 'recording', aliases: ['fakerecording'], summary: 'Show “recording…” instead of “typing…” while replying', on: 'The bot will show “recording…” while it prepares replies.', off: 'The bot will show “typing…” while it prepares replies.' },
];

function switchCommand(item: Switch): Command {
  return {
    name: item.name,
    aliases: item.aliases,
    category: 'admin',
    adminOnly: true,
    summary: item.summary,
    usage: `.${item.name} <on|off>`,
    async handler(context) {
      const wanted = context.argv[0]?.toLowerCase();
      if (wanted !== 'on' && wanted !== 'off') {
        const current = (await getSetting(item.name)) === 'on' ? 'on' : 'off';
        await context.reply(`*${item.summary}:* ${current}\nChange it with \`.${item.name} on\` or \`.${item.name} off\`.`);
        return;
      }
      await setSetting(item.name, wanted);
      forgetSwitch(item.name);
      await context.reply(`${wanted === 'on' ? '✅' : '⏹️'} ${wanted === 'on' ? item.on : item.off}`);
    },
  };
}

export const ownerSwitchCommands: Command[] = SWITCHES.map(switchCommand);

const AI_HELP = [
  '*.aimode on* — the AI answers every private message',
  '*.aimode off* — the AI answers only people who start with an AI command (.cv, .ask, .profile, .apply…), for 30 minutes; everyone else is yours',
  'In a chat: *.aimode stop* — the AI never answers there; *.aimode start* — it answers again',
  '*.stop* — end the AI conversation in a chat right now (anyone can use it)',
  'When you type in a chat yourself, the AI steps back there automatically.',
].join('\n');

/** End the AI conversation in this chat now. Anyone: a member who is done, or the owner. */
export const stopCommand: Command = {
  name: 'stop',
  aliases: ['endchat', 'bye'],
  category: 'system',
  summary: 'End the AI conversation in this private chat',
  usage: '.stop',
  async handler(context) {
    if (context.isGroup) return;
    endSession(context.chatJid);
    await context.react('👋').catch(() => undefined);
  },
};

/** Whether the AI answers private messages: the bot may be on a personal number. */
export const aiModeCommand: Command = {
  name: 'aimode',
  aliases: ['assistantmode', 'autoreply'],
  category: 'admin',
  adminOnly: true,
  summary: 'Choose when the AI answers private messages (on, off, stop or start a chat)',
  usage: '.aimode [on|off|stop|start]',
  examples: ['.aimode', '.aimode off', '.aimode stop'],
  async handler(context) {
    const wanted = context.argv[0]?.toLowerCase();
    // Typed inside someone else's private chat: act on that chat, and answer
    // the owner privately rather than in front of the other person.
    const own = (jid: string | null): string => (jid ?? '').split('@')[0]!.split(':')[0]!;
    const inOwnChat = !context.isGroup && [context.selfJid, context.selfLid, context.senderJid].some((jid) => jid && own(jid) === own(context.chatJid));
    const inOtherChat = !context.isGroup && !inOwnChat;
    const tellOwner = async (text: string): Promise<void> => {
      if (inOtherChat) {
        await context.react('🤖').catch(() => undefined);
        await careerMessenger()?.sendText(context.senderJid, text).catch(() => undefined);
      } else {
        await context.reply(text);
      }
    };

    if (wanted === 'on' || wanted === 'off') {
      await setAiMode(wanted === 'on');
      await tellOwner(wanted === 'on'
        ? '🤖 AI mode *ON*: the AI answers every private message (except chats you stopped or are typing in).'
        : '🙋 AI mode *OFF*: private messages are yours. The AI answers only people who start with an AI command such as .cv or .ask.');
      return;
    }
    if (wanted === 'stop' || wanted === 'start') {
      if (context.isGroup) {
        await context.reply('Send *.aimode stop* or *.aimode start* inside a private chat.');
        return;
      }
      await setChatStopped(context.chatJid, wanted === 'stop');
      if (wanted === 'start') openSession(context.chatJid);
      const who = inOwnChat ? 'in this chat' : `+${own(context.chatJid)}`;
      await tellOwner(wanted === 'stop'
        ? `🔕 The AI will not answer ${inOwnChat ? 'here' : who} any more (commands still work). Send *.aimode start* ${inOwnChat ? 'here' : 'in that chat'} to undo.`
        : `🤖 The AI is answering ${inOwnChat ? 'here' : who} again.`);
      return;
    }
    const status = await aiStatus();
    await tellOwner([
      `*AI in private chats:* ${status.mode ? 'ON — answers everyone' : 'OFF — only people who used an AI command'}`,
      `Conversations open now: ${status.sessions} · chats you took over: ${status.takenOver} · chats stopped: ${status.stopped}`,
      '',
      AI_HELP,
    ].join('\n'));
  },
};

/** Everyone who has messaged the bot, as a vCard file to import into a phone in one tap. */
export const contactsCommand: Command = {
  name: 'contacts',
  aliases: ['savecontacts', 'exportcontacts'],
  category: 'admin',
  adminOnly: true,
  summary: 'Everyone who has messaged the bot, as a contacts file for your phone',
  usage: '.contacts',
  async handler(context) {
    const rows = await sql<{ wa_jid: string; display_name: string | null; created_at: Date }[]>`
      select wa_jid, display_name, created_at from members where wa_jid like '%@s.whatsapp.net' and not is_blocked order by created_at`;
    if (rows.length === 0) {
      await context.reply('No contacts yet.');
      return;
    }
    const file = Buffer.from(vcards(rows.map((row) => ({ jid: row.wa_jid, name: row.display_name }))), 'utf8');
    await careerMessenger()?.sendDocument(context.chatJid, file, `phc-contacts-${new Date().toISOString().slice(0, 10)}.vcf`, 'text/vcard', `📇 ${rows.length} contacts — open the file to add them to your phone.`);
  },
};
