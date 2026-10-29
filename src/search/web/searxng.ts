/**
 * SearXNG — self-hosted metasearch.
 *
 * The zero-cost-forever option: no key, no quota, no vendor. You run it, so
 * nobody can price you out of your own fallback.
 *
 * Deliberately points at an instance you host. Public instances are not a
 * supported target: most serve a captcha to automated callers, and hammering
 * someone else's free instance to power a community bot is not reasonable use.
 *
 * Run one with:
 *   docker run -d -p 8080:8080 -e SEARXNG_BASE_URL=http://localhost:8080/ searxng/searxng
 * then set SEARXNG_URL=http://localhost:8080
 *
 * The JSON API must be enabled in that instance's `settings.yml`:
 *   search:
 *     formats: [html, json]
 */
import { env } from '../../config/env.js';
import { safeDate } from '../../domain/normalize.js';
import { WebSearchError, type WebSearchProvider, type WebSearchRequest, type WebSearchResult } from './provider.js';

const TIMEOUT_MS = 25_000;

interface SearxResult {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: string;
}

interface SearxResponse {
  results?: SearxResult[];
}

export function createSearxngProvider(): WebSearchProvider {
  const base = env.SEARXNG_URL.trim().replace(/\/+$/, '');

  return {
    name: 'searxng',
    unavailableReason:
      base.length > 0 ? null : 'SEARXNG_URL is not set — point it at a SearXNG instance you host',

    async search(request: WebSearchRequest): Promise<WebSearchResult[]> {
      if (base.length === 0) throw new WebSearchError('SEARXNG_URL is not set');

      const url = new URL(`${base}/search`);
      url.searchParams.set('q', request.query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('safesearch', '1');
      // Recency, where the instance's engines support it.
      if (request.withinDays && request.withinDays <= 31) {
        url.searchParams.set('time_range', request.withinDays <= 7 ? 'week' : 'month');
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      request.signal?.addEventListener('abort', () => controller.abort(), { once: true });

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { accept: 'application/json', 'user-agent': 'PHC-Platform/0.1' },
        });

        if (!response.ok) {
          throw new WebSearchError(
            `SearXNG returned ${response.status}`,
            response.status === 429 || response.status >= 500,
          );
        }

        // A misconfigured instance serves HTML even when asked for JSON, which
        // would otherwise surface as an opaque parse error.
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('json')) {
          throw new WebSearchError(
            'SearXNG did not return JSON — enable the json format in its settings.yml',
          );
        }

        const payload = (await response.json()) as SearxResponse;
        const results = Array.isArray(payload.results) ? payload.results : [];

        return results.slice(0, request.limit ?? 10).flatMap((result): WebSearchResult[] => {
          if (typeof result.url !== 'string' || typeof result.title !== 'string') return [];
          return [
            {
              title: result.title,
              url: result.url,
              snippet: (result.content ?? '').slice(0, 1200),
              publishedAt: safeDate(result.publishedDate ?? null),
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
