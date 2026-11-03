/**
 * Shared search-command behaviour.
 *
 * `.job`, `.jobs`, `.scholarships`, `.internships` and friends differ only in
 * which types they force and what they call themselves, so the pipeline lives
 * here once.
 */
import { consumeAiQuota } from '../../ai/quota.js';
import { isAiAvailable } from '../../ai/router.js';
import { logCommand } from '../../db/repositories/members.js';
import type { OpportunityType } from '../../domain/opportunity.js';
import { DEFAULT_PAGE_SIZE, parseQuery } from '../../search/query.js';
import { search } from '../../search/search.service.js';
import { tokens } from '../../core/text.js';
import { renderResults } from '../../whatsapp/format.js';
import type { CommandContext } from '../types.js';

export interface RunSearchOptions {
  /** Types the command itself implies, e.g. `.scholarships` -> SCHOLARSHIP. */
  forcedTypes?: OpportunityType[];
  /** Label used in pagination hints and the command log. */
  commandLabel: string;
  /** Search this text instead of the command's arguments (e.g. a cleaned-up .ask question). */
  text?: string;
  /** Force the AI web search to run alongside the sources. */
  aiAugment?: boolean;
}

/**
 * Parse, search, reply and record.
 *
 * The member gets a reaction immediately and the result when it is ready, so a
 * slow upstream never looks like a dead bot.
 */
export async function runSearch(context: CommandContext, options: RunSearchOptions): Promise<void> {
  const startedAt = Date.now();

  const query = parseQuery(options.text ?? context.args, {
    ...(options.forcedTypes ? { forcedTypes: options.forcedTypes } : {}),
    limit: DEFAULT_PAGE_SIZE,
    offset: 0,
  });

  await context.react('🔎');

  try {
    // The fallback costs money per call, so it is allowed only when AI is
    // configured and this member still has budget. The quota is consumed up
    // front; an unused reservation simply expires with the window.
    const allowAiFallback = isAiAvailable() && consumeAiQuota(context.member.id).allowed;

    // Scholarships, internships, fellowships, research, grants, events,
    // conferences and training live largely on the open web, so for those
    // commands the AI web search runs every time alongside the sources.
    const aiAugment = options.aiAugment ?? (options.forcedTypes ?? []).some((type) => type !== 'JOB');

    const outcome = await search(query, {
      allowAiFallback,
      aiAugment,
      member: {
        country: context.member.country,
        interests: context.member.interests,
        skills: context.member.skills,
        preferredLocations: context.member.preferredLocations,
        remotePreference: context.member.remotePreference,
      },
    });

    // Remembered so `.next`, `.prev` and `.details <n>` can act on this page.
    context.setSession({
      query,
      command: options.commandLabel,
      page: outcome.results,
      totalMatched: outcome.totalMatched,
      createdAt: Date.now(),
    });

    await context.reply(
      renderResults({ query, outcome, command: options.commandLabel }),
    );

    await logCommand({
      memberId: context.member.id,
      command: options.commandLabel,
      queryTerms: tokens(query.terms),
      resultCount: outcome.totalMatched,
      durationMs: Date.now() - startedAt,
      ok: true,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    context.log.error({ err: message }, 'search command failed');

    await context.reply(
      '⚠️ The search could not be completed just now. Please try again in a moment.\n\n' +
        'If it keeps failing, an administrator can check source health with `.sources`.',
    );

    await logCommand({
      memberId: context.member.id,
      command: options.commandLabel,
      queryTerms: tokens(query.terms),
      resultCount: null,
      durationMs: Date.now() - startedAt,
      ok: false,
      errorKind: cause instanceof Error ? cause.name : 'UnknownError',
    });
  }
}
