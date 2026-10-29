/**
 * Web search, decoupled from the AI provider.
 *
 * Originally the opportunity fallback relied on the model's own built-in
 * search (Anthropic's server-side tool, Gemini's Google grounding). That
 * turned out to be a paid feature on both, which left the fallback unusable on
 * a free key even though plain generation worked perfectly well.
 *
 * Splitting the two fixes that: any search backend can supply the pages, and
 * any model can read them. Search and reasoning are now independently
 * swappable, and a free search backend plus a free model gives a working
 * fallback at no cost.
 */

export interface WebSearchResult {
  title: string;
  url: string;
  /** Snippet or extracted content. May be empty. */
  snippet: string;
  /** Publication date when the backend reports one. */
  publishedAt?: Date | null;
}

export interface WebSearchRequest {
  query: string;
  /** Maximum results to return. Backends may return fewer. */
  limit?: number;
  /** Restrict to pages published within this many days, when supported. */
  withinDays?: number | null;
  signal?: AbortSignal;
}

export interface WebSearchProvider {
  /** Stable identifier used in config and logs. */
  readonly name: string;
  /** Why it cannot run, or null when ready. */
  readonly unavailableReason: string | null;
  search(request: WebSearchRequest): Promise<WebSearchResult[]>;
}

export class WebSearchError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'WebSearchError';
  }
}

/**
 * Render results as a context block for a model to read.
 *
 * Numbered and URL-bearing on purpose: the extraction prompt tells the model it
 * may only report opportunities that appear here, and a visible index makes
 * that instruction checkable rather than aspirational.
 */
export function renderSearchContext(results: WebSearchResult[]): string {
  return results
    .map((result, index) => {
      const date = result.publishedAt ? ` (published ${result.publishedAt.toISOString().slice(0, 10)})` : '';
      return `[${index + 1}] ${result.title}${date}\nURL: ${result.url}\n${result.snippet}`.trim();
    })
    .join('\n\n');
}
