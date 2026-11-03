/**
 * Provider selection.
 *
 * Resolves `AI_PROVIDER` to a concrete implementation, lazily and once. When no
 * provider is configured — or the configured one cannot start — this returns
 * null rather than throwing, because every AI feature is additive: search,
 * commands and classification must keep working without one.
 */
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import { createAnthropicProvider } from './anthropic/provider.js';
import { createDeepSeekProvider } from './deepseek/provider.js';
import { createGeminiProvider } from './gemini/provider.js';
import { AiError, type AiProvider } from './provider.js';

const log = logger.child({ component: 'ai:router' });

let cached: AiProvider | null | undefined;

/** The active provider, or null when AI is unavailable. */
export function getAiProvider(): AiProvider | null {
  if (cached !== undefined) return cached;

  switch (env.AI_PROVIDER) {
    case 'gemini':
      try {
        cached = createGeminiProvider();
        log.info({ provider: 'gemini', model: cached.model }, 'AI provider ready');
      } catch (cause) {
        const reason = cause instanceof AiError ? cause.message : String(cause);
        log.warn({ reason }, 'AI provider not available — AI features stay disabled');
        cached = null;
      }
      break;

    case 'anthropic':
      try {
        cached = createAnthropicProvider();
        log.info({ provider: 'anthropic', model: cached.model }, 'AI provider ready');
      } catch (cause) {
        const reason = cause instanceof AiError ? cause.message : String(cause);
        log.warn({ reason }, 'AI provider not available — AI features stay disabled');
        cached = null;
      }
      break;

    case 'deepseek':
      try {
        cached = createDeepSeekProvider();
        log.info({ provider: 'deepseek', model: cached.model }, 'AI provider ready');
      } catch (cause) {
        const reason = cause instanceof AiError ? cause.message : String(cause);
        log.warn({ reason }, 'AI provider not available — AI features stay disabled');
        cached = null;
      }
      break;

    case 'openai':
      // Phase 6. Named explicitly so a misconfiguration is obvious in the log
      // rather than looking like a missing key.
      log.warn('AI_PROVIDER=openai is not implemented yet — AI features stay disabled');
      cached = null;
      break;

    case 'none':
    default:
      cached = null;
      break;
  }

  return cached;
}

export function isAiAvailable(): boolean {
  return getAiProvider() !== null;
}

let trackerCached: AiProvider | null | undefined;

/**
 * The provider the site tracker classifies listings with: DeepSeek whenever
 * its key is set, otherwise the main provider, otherwise null (the tracker
 * then filters by keywords alone).
 */
export function getTrackerAiProvider(): AiProvider | null {
  if (trackerCached !== undefined) return trackerCached;
  if (env.DEEPSEEK_API_KEY.trim().length > 0) {
    try {
      trackerCached = createDeepSeekProvider();
      return trackerCached;
    } catch {
      // fall through to the main provider
    }
  }
  trackerCached = getAiProvider();
  return trackerCached;
}

/** Reset the cached provider. Used by tests. */
export function resetAiProvider(): void {
  cached = undefined;
  trackerCached = undefined;
}
