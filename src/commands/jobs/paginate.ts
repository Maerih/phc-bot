/**
 * `.next` / `.prev` — move through the last result set.
 *
 * The page is re-derived from the remembered query rather than from a stored
 * result list, so results stay consistent with the current source cache and a
 * long-idle session cannot serve a stale page silently.
 */
import { DEFAULT_PAGE_SIZE } from '../../search/query.js';
import { search } from '../../search/search.service.js';
import { renderResults } from '../../whatsapp/format.js';
import type { Command, CommandContext } from '../types.js';

/** Sessions older than this are treated as gone. */
const SESSION_TTL_MS = 30 * 60 * 1000;

async function paginate(context: CommandContext, direction: 1 | -1): Promise<void> {
  const session = context.getSession();

  if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) {
    await context.reply('There is no recent search to page through. Start one with `.jobs` or `.job <keywords>`.');
    return;
  }

  const pageSize = session.query.limit || DEFAULT_PAGE_SIZE;
  const nextOffset = session.query.offset + direction * pageSize;

  if (nextOffset < 0) {
    await context.reply('You are already on the first page.');
    return;
  }

  if (nextOffset >= session.totalMatched) {
    await context.reply(`That is the end of the results (${session.totalMatched} total).`);
    return;
  }

  const query = { ...session.query, offset: nextOffset };
  await context.react('🔎');

  const outcome = await search(query, {
    member: {
      country: context.member.country,
      interests: context.member.interests,
      skills: context.member.skills,
      remotePreference: context.member.remotePreference,
    },
  });

  context.setSession({
    query,
    command: session.command,
    page: outcome.results,
    totalMatched: outcome.totalMatched,
    createdAt: Date.now(),
  });

  await context.reply(renderResults({ query, outcome, command: session.command }));
}

export const nextCommand: Command = {
  name: 'next',
  aliases: ['more'],
  category: 'jobs',
  summary: 'Next page of results',
  usage: '.next',
  async handler(context) {
    await paginate(context, 1);
  },
};

export const prevCommand: Command = {
  name: 'prev',
  aliases: ['previous', 'back'],
  category: 'jobs',
  summary: 'Previous page of results',
  usage: '.prev',
  async handler(context) {
    await paginate(context, -1);
  },
};
