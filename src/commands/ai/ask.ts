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
          '*Ask me a public-health question.*',
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
