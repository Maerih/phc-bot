/**
 * Career commands: shortcuts into the career assistant for members who prefer
 * commands to conversation. Everything personal happens in private chat; in a
 * group these send the member a private message instead.
 */
import { assistantAvailable, runAssistant } from '../../career/agent.js';
import { prepareApplication } from '../../career/applications.js';
import { careerMessenger } from '../../career/messenger.js';
import { CONSENT_TEXT, cvReadiness, describeProfile } from '../../career/profile.js';
import * as store from '../../career/store.js';
import { TEMPLATES } from '../../career/templates.js';
import type { Command, CommandContext } from '../types.js';

/** Personal things never happen in a group: move the member to a private chat. */
async function privately(context: CommandContext, opener: string): Promise<boolean> {
  if (!context.isGroup) return true;
  await careerMessenger()?.sendText(context.senderJid, opener).catch(() => undefined);
  await context.reply('📩 I have sent you a private message — CVs and applications are handled privately.');
  return false;
}

async function ask(context: CommandContext, text: string): Promise<void> {
  if (!assistantAvailable()) {
    await context.reply('The career assistant needs the DeepSeek key on this server. Ask an administrator to add it.');
    return;
  }
  await runAssistant({ memberId: context.member.id, chatJid: context.chatJid, isAdmin: context.isAdmin, text, reply: (message) => context.reply(message) });
}

export const cvCommand: Command = {
  name: 'cv',
  aliases: ['resume', 'buildcv'],
  category: 'ai',
  summary: 'Build a professional CV (PDF and Word), optionally for a role',
  usage: '.cv [role or job] · .cv classic [role]',
  examples: ['.cv', '.cv public health officer', '.cv classic research assistant'],
  async handler(context) {
    if (!(await privately(context, 'Hi! Let’s build your CV here. Tell me the kind of role you are aiming for, or send me your current CV as a PDF or Word file.'))) return;
    const [first, ...rest] = context.argv;
    const template = first && first.toLowerCase() in TEMPLATES ? first.toLowerCase() : null;
    const role = (template ? rest : context.argv).join(' ').trim();
    await ask(context, `Build me a CV${role ? ` for ${role}` : ''}${template ? ` using the ${template} template` : ''}.`);
  },
};

export const profileCommand: Command = {
  name: 'profile',
  aliases: ['myprofile'],
  category: 'ai',
  summary: 'See or update your professional profile',
  usage: '.profile [what to add or change]',
  examples: ['.profile', '.profile I finished my MPH at Moi University in 2025'],
  async handler(context) {
    if (!(await privately(context, 'Hi! Your profile is private — let’s look at it here. Send *.profile* to see it.'))) return;
    if (context.args.trim()) {
      await ask(context, `Update my profile: ${context.args}`);
      return;
    }
    const { profile, consentAt } = await store.getProfile(context.member.id);
    if (!consentAt) {
      await context.reply(`${CONSENT_TEXT}\n\nOr just tell me about yourself, or send your CV as a file.`);
      return;
    }
    const readiness = cvReadiness(profile);
    await context.reply(
      [
        '👤 *Your profile*',
        '',
        describeProfile(profile),
        '',
        readiness.ready ? '✅ Ready for a CV — send *.cv* or *.cv <role>*.' : `Still needed for a CV: ${readiness.missing.join('; ')}.`,
        'Change anything by telling me, e.g. “add Excel and SPSS to my skills”.',
      ].join('\n'),
    );
  },
};

export const applyCommand: Command = {
  name: 'apply',
  category: 'ai',
  summary: 'Prepare an application (CV, cover letter, email) for result number N',
  usage: '.apply <number> [more numbers]',
  examples: ['.apply 2', '.apply 1 3'],
  async handler(context) {
    if (!(await privately(context, 'Hi! Search here with *.job*, *.internships* or *.scholarships*, then send *.apply <number>* and I will prepare the application privately.'))) return;
    const numbers = context.argv.map((token) => Number.parseInt(token.replace('#', ''), 10)).filter((value) => Number.isInteger(value) && value > 0).slice(0, 5);
    const session = context.getSession();
    if (numbers.length === 0 || !session || session.page.length === 0) {
      await ask(context, context.args.trim() ? `Prepare an application for: ${context.args}` : 'I want to apply for something. Help me find a suitable opportunity.');
      return;
    }
    const { consentAt, profile } = await store.getProfile(context.member.id);
    if (!consentAt) {
      await ask(context, `Prepare applications for results ${numbers.join(', ')} of my last search.`);
      return;
    }
    const readiness = cvReadiness(profile);
    if (!readiness.ready) {
      await context.reply(`Before I can apply for you I need ${readiness.missing.join('; ')}. Tell me, or send your CV as a file.`);
      return;
    }
    const chosen = numbers.map((number) => session.page[number - 1]).filter((item) => item !== undefined);
    if (chosen.length === 0) {
      await context.reply('Those numbers are not in your last results. Send *.next* or search again.');
      return;
    }
    await context.reply(`⏳ Preparing ${chosen.length} application${chosen.length === 1 ? '' : 's'}: finding the official channel, tailoring your CV and writing the cover letter. This takes a minute or two each.`);
    const deliver = {
      text: (message: string) => context.reply(message),
      file: async (data: Buffer, fileName: string, mime: string, caption?: string) => careerMessenger()?.sendDocument(context.chatJid, data, fileName, mime, caption),
    };
    void (async () => {
      for (const item of chosen) {
        const opportunity = item!.opportunity;
        try {
          const result = await prepareApplication(
            context.member.id,
            {
              title: opportunity.title,
              organization: opportunity.organization ?? null,
              url: opportunity.applicationUrl ?? opportunity.sourceUrl ?? '',
              listingUrl: opportunity.sourceUrl ?? null,
              deadline: opportunity.deadline ? new Date(opportunity.deadline).toISOString().slice(0, 10) : null,
              location: opportunity.location ?? null,
              summary: opportunity.description?.slice(0, 500) ?? null,
              source: opportunity.sourceSlug ?? null,
            },
            deliver,
          );
          if (result.status === 'existing') await context.reply(`ℹ️ You already have application #${result.number} for “${opportunity.title}”. Send *.applications* to see it.`);
        } catch {
          await context.reply(`⚠️ I could not prepare the application for “${opportunity.title}”. Try again in a minute.`);
        }
      }
    })();
  },
};

const STATUS_LABEL: Record<store.ApplicationStatus, string> = {
  preparing: '⏳ preparing',
  needs_info: '❔ needs information',
  ready_to_send: '📨 ready for you to send',
  awaiting_approval: '📝 waiting for your approval',
  submitted: '✅ submitted',
  cancelled: '✖️ cancelled',
  failed: '⚠️ failed — ask me to retry',
};

export const applicationsCommand: Command = {
  name: 'applications',
  aliases: ['myapplications', 'applied'],
  category: 'ai',
  summary: 'Your applications and their status',
  usage: '.applications',
  async handler(context) {
    if (!(await privately(context, 'Hi! Your applications are private — send *.applications* here to see them.'))) return;
    const applications = await store.listApplications(context.member.id);
    if (applications.length === 0) {
      await context.reply('You have no applications yet. Search with *.job*, *.internships* or *.scholarships*, then send *.apply <number>* — or just tell me what you are looking for.');
      return;
    }
    await context.reply(
      [
        '🗂️ *Your applications*',
        '',
        ...applications.slice(0, 20).map((item) => {
          const deadline = item.channelDetail.deadline ?? item.opportunity.deadline;
          return `*#${item.number}* ${item.opportunity.title}${item.opportunity.organization ? ` — ${item.opportunity.organization}` : ''}\n   ${STATUS_LABEL[item.status]}${deadline ? ` · deadline ${deadline}` : ''}${item.reference ? ` · ref ${item.reference}` : ''}${item.submittedAt ? ` · sent ${new Date(item.submittedAt).toISOString().slice(0, 10)}` : ''}`;
        }),
        '',
        'Tell me *sent <number>* when you have applied, or ask me about any of them.',
      ].join('\n'),
    );
  },
};

export const deleteDataCommand: Command = {
  name: 'deletemydata',
  aliases: ['forgetme'],
  category: 'ai',
  summary: 'Delete your profile, CVs and application history',
  usage: '.deletemydata',
  async handler(context) {
    if (!(await privately(context, 'Hi! To delete your data, send *delete my data* here.'))) return;
    await ask(context, 'delete my data');
  },
};
