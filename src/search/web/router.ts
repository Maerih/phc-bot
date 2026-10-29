/**
 * Web-search backend selection.
 *
 * Mirrors the AI router: resolve configuration to one implementation, lazily
 * and once, and return null rather than throwing when nothing is usable.
 */
import { env } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { createSearxngProvider } from './searxng.js';
import { createTavilyProvider } from './tavily.js';
import type { WebSearchProvider } from './provider.js';

const log = logger.child({ component: 'web-search:router' });

let cached: WebSearchProvider | null | undefined;

/**
 * The active web-search backend, or null.
 *
 * `provider` means "let the AI provider do its own grounded search" — the
 * original behaviour, which both Anthropic and Google bill for.
 */
export function getWebSearchProvider(): WebSearchProvider | null {
  if (cached !== undefined) return cached;

  switch (env.WEB_SEARCH_PROVIDER) {
    case 'tavily':
      cached = usable(createTavilyProvider());
      break;
    case 'searxng':
      cached = usable(createSearxngProvider());
      break;
    case 'provider':
    case 'none':
    default:
      cached = null;
      break;
  }

  return cached;
}

function usable(provider: WebSearchProvider): WebSearchProvider | null {
  if (provider.unavailableReason) {
    log.warn(
      { backend: provider.name, reason: provider.unavailableReason },
      'web search backend not available',
    );
    return null;
  }
  log.info({ backend: provider.name }, 'web search backend ready');
  return provider;
}

/** True when the operator asked the AI provider to do its own grounded search. */
export function usesProviderGrounding(): boolean {
  return env.WEB_SEARCH_PROVIDER === 'provider';
}

/** Exposed for tests. */
export function resetWebSearchProvider(): void {
  cached = undefined;
}
