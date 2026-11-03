/**
 * `.ask` — general question answering.
 *
 * One command backed by the provider abstraction, rather than a separate
 * command per vendor. `.gpt`, `.claude` and friends would be nine commands
 * that differ only in which company bills you, and would hard-code vendor
 * choice into the command surface — exactly what the AI layer exists to avoid.
 * Which model answers is an operator decision in `.env`, not something a
 * member should have to know.
 */
import { getAiProvider } from '../../ai/router.js';
import { AI_CALLS_PER_HOUR, consumeAiQuota } from '../../ai/quota.js';
import { ASK_SYSTEM_PROMPT, asUserQuestion } from '../../ai/prompts.js';
import { AiError, describeAiError } from '../../ai/provider.js';
import { logCommand } from '../../db/repositories/members.js';
import { truncate } from '../../core/text.js';
import { POWERED_BY } from '../../whatsapp/format.js';
import type { Command } from '../types.js';
import { runSearch } from '../opportunities/run-search.js';

const OPPORTUNITY_WORDS =
  /\b(jobs?|vacanc\w*|internships?|attachments?|scholarships?|bursar\w*|fellowships?|grants?|funding|opportunit\w*|positions?|openings?|trainings?|short courses?|conferences?|volunteer\w*|webinars?|postdocs?|phd positions?)\b/i;
const ASKING_TO_FIND =
  /\b(find|search|look(ing)? for|show( me)?|list|any|are there|get me|recommend|need|want|available|latest|open|current|where can i (get|find|apply))\b/i;
const FILLER =
  /\b(please|pls|kindly|can|could|you|help|me|find|search|look(ing)?|for|show|list|any|are|is|there|get|recommend|i|i'm|im|am|need|want|some|available|latest|current|open|opportunities|opportunity|a|an|the|in|at|on|with|of|to|where|apply|which|what|good)\b/gi;

/**
 * The search words of a question that asks for opportunities, or null when
 * it is an ordinary question for the assistant.
 */
export function opportunitySearchText(question: string): string | null {
  if (!OPPORTUNITY_WORDS.test(question)) return null;
  const words = question.trim().split(/\s+/).length;
  if (!ASKING_TO_FIND.test(question) && words > 6) return null;
  // How-to questions about opportunities are for the assistant, not the search.
  if (/^\s*(how|why|what is|what are|explain|tips|should)\b/i.test(question)) return null;
  // Keep the type words: the search reads them to know what to look for.
  return question.replace(/[?!.,]/g, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim() || question;
}

/** Long enough for a real question, short enough not to be an upload channel. */
const MAX_QUESTION_CHARS = 1000;

export const askCommand: Command = {
  name: 'ask',
  aliases: ['ai', 'assistant'],
  category: 'ai',
  summary: 'Ask a public-health question',
  usage: '.ask <question>',
  examples: [
    '.ask what does an epidemiologist actually do day to day',
    '.ask how do I prepare for an MPH application',
    '.ask explain confounding in simple terms',
  ],

  async handler(context) {
    const provider = getAiProvider();

    if (!provider) {
      await context.reply(
        [
          'The assistant is not switched on for this community yet.',
          '',
          'You can still search opportunities:',
          '• `.job public health`',
          '• `.scholarships`',
          '• `.help` for everything else',
        ].join('\n'),
      );
      return;
    }

    const question = context.args.trim();

    if (question.length === 0) {
      await context.reply(
        [
          '*Ask me anything — or ask me to find opportunities.*',
          '',
          'For example:',
          '• `.ask what does an epidemiologist do`',
          '• `.ask how do I prepare for an MPH application`',
          '• `.ask explain confounding in simple terms`',
          '',
          'For opportunities use `.job`, `.scholarships` or `.internships` — those',
          'return real listings with links, which I will not invent.',
        ].join('\n'),
      );
      return;
    }

    if (question.length > MAX_QUESTION_CHARS) {
      await context.reply(
        `That question is ${question.length} characters. Please keep it under ${MAX_QUESTION_CHARS}.`,
      );
      return;
    }

    // "Find me nutrition internships in Kisumu" is a search, not a chat: run
    // the real search (sources plus AI web search) so the answer is listings
    // with links, never ones the model made up.
    const searchText = opportunitySearchText(question);
    if (searchText !== null) {
      await runSearch(context, { commandLabel: '.ask', text: searchText, aiAugment: true });
      return;
    }

    // Budget guard, separate from the general command rate limit.
    const quota = consumeAiQuota(context.member.id);
    if (!quota.allowed) {
      await context.reply(
        `You have used your ${AI_CALLS_PER_HOUR} assistant questions for this hour. ` +
          `Try again in about ${quota.resetInMinutes} minute(s).\n\n` +
          'Opportunity search is unaffected — `.job`, `.scholarships` and the rest still work.',
      );
      return;
    }

    await context.react('💭');
    const startedAt = Date.now();

    try {
      const result = await provider.complete({
        system: ASK_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: asUserQuestion(question) }],
      });

      // Guard against a model that ignores the brevity instruction; WhatsApp
      // truncates very long messages unhelpfully.
      const answer = truncate(result.text, 3000);

      await context.reply(`${answer}\n\n_${POWERED_BY}_`);

      context.log.info(
        {
          provider: result.provider,
          model: result.model,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          durationMs: Date.now() - startedAt,
        },
        'ai question answered',
      );

      await logCommand({
        memberId: context.member.id,
        command: '.ask',
        // The question itself is never stored: it is a member's own words and
        // may be personal. Only that the command ran.
        queryTerms: [],
        resultCount: 1,
        durationMs: Date.now() - startedAt,
        ok: true,
      });
    } catch (cause) {
      const error = cause instanceof AiError ? cause : new AiError('UNKNOWN', String(cause));
      context.log.warn({ kind: error.kind }, 'ai question failed');

      await context.reply(describeAiError(error));

      await logCommand({
        memberId: context.member.id,
        command: '.ask',
        queryTerms: [],
        resultCount: null,
        durationMs: Date.now() - startedAt,
        ok: false,
        errorKind: error.kind,
      });
    }
  },
};
