/**
 * Owner switches for how the bot's own account behaves, and the contact list.
 * Platform administrators only. Every switch starts off.
 */
import { vcards } from './vcard.js';
import { connection as sql } from '../../db/client.js';
import { careerMessenger } from '../../career/messenger.js';
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
