/**
 * Tavily — search API built for AI agents.
 *
 * Free tier, key from https://app.tavily.com/. Returns cleaned page content
 * rather than raw HTML, which keeps the extraction prompt short and cheap.
 *
 * API: https://docs.tavily.com/
 */
import { env } from '../../config/env.js';
import { safeDate } from '../../domain/normalize.js';
import { WebSearchError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from './provider.js';

const ENDPOINT = 'https://api.tavily.com/search';
const TIMEOUT_MS = 25_000;

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

export function createTavilyProvider(): WebSearchProvider {
  const apiKey = env.TAVILY_API_KEY.trim();

  return {
    name: 'tavily',
    unavailableReason:
      apiKey.length > 0 ? null : 'TAVILY_API_KEY is not set — get a free key at https://app.tavily.com/',

    async search(request: WebSearchRequest): Promise<WebSearchResult[]> {
      if (apiKey.length === 0) throw new WebSearchError('TAVILY_API_KEY is not set');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      // Honour an externally supplied signal as well as our own timeout.
      request.signal?.addEventListener('abort', () => controller.abort(), { once: true });

      try {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            query: request.query,
            max_results: Math.min(request.limit ?? 10, 20),
            search_depth: 'basic',
            // Recency matters for opportunities: a closed scholarship is noise.
            ...(request.withinDays ? { days: request.withinDays, topic: 'news' } : {}),
          }),
        });

        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          throw new WebSearchError(`Tavily returned ${response.status}`, retryable);
        }

        const payload = (await response.json()) as TavilyResponse;
        const results = Array.isArray(payload.results) ? payload.results : [];

        return results.flatMap((result): WebSearchResult[] => {
          if (typeof result.url !== 'string' || typeof result.title !== 'string') return [];
          return [
            {
              title: result.title,
              url: result.url,
              snippet: (result.content ?? '').slice(0, 1200),
              publishedAt: safeDate(result.published_date ?? null),
            },
          ];
        });
      } catch (cause) {
        if (cause instanceof WebSearchError) throw cause;
        if (cause instanceof Error && cause.name === 'AbortError') {
          throw new WebSearchError('the search timed out', true);
        }
        throw new WebSearchError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
