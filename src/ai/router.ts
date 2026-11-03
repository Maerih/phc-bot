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

type ProviderName = 'gemini' | 'anthropic' | 'deepseek';

const FACTORIES: Record<ProviderName, () => AiProvider> = {
  deepseek: createDeepSeekProvider,
  gemini: createGeminiProvider,
  anthropic: createAnthropicProvider,
};

/**
 * Which providers to try, in order. "auto" (the default) prefers DeepSeek,
 * then Gemini, then Anthropic — whichever has a key. A named provider is tried
 * first, and if it has no key the others are tried rather than switching AI
 * off: a server set up with AI_PROVIDER=gemini but only a DeepSeek key still
 * has an assistant.
 */
function candidates(): ProviderName[] {
  const order: ProviderName[] = ['deepseek', 'gemini', 'anthropic'];
  const chosen = env.AI_PROVIDER;
  if (chosen === 'gemini' || chosen === 'anthropic' || chosen === 'deepseek') {
    return [chosen, ...order.filter((name) => name !== chosen)];
  }
  return order;
}

/** The active provider, or null when AI is unavailable. */
export function getAiProvider(): AiProvider | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (env.AI_PROVIDER === 'none') return cached;
  if (env.AI_PROVIDER === 'openai') {
    // Not implemented. Named explicitly so a misconfiguration is obvious in
    // the log rather than looking like a missing key; other providers are
    // still tried below.
    log.warn('AI_PROVIDER=openai is not implemented yet — trying the other providers');
  }

  for (const name of candidates()) {
    try {
      cached = FACTORIES[name]();
      log.info({ provider: name, model: cached.model }, 'AI provider ready');
      return cached;
    } catch (cause) {
      const reason = cause instanceof AiError ? cause.message : String(cause);
      log.debug({ provider: name, reason }, 'AI provider not available');
    }
  }
  log.warn('no AI provider has a key — AI features stay disabled');
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

/**
 * The provider for `.ask`: DeepSeek whenever its key is set, whatever
 * AI_PROVIDER says; otherwise the main provider.
 */
export function getAssistantProvider(): AiProvider | null {
  return getTrackerAiProvider();
}

/** Reset the cached provider. Used by tests. */
export function resetAiProvider(): void {
  cached = undefined;
  trackerCached = undefined;
}
