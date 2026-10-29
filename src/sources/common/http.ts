/**
 * Outbound HTTP for source connectors.
 *
 * Centralised so every upstream call gets the same timeout handling, identifying
 * user-agent, response-size ceiling and retry policy. Connectors never call
 * `fetch` directly.
 */
import { logger } from '../../core/logger.js';

const log = logger.child({ component: 'source-http' });

/** Identify ourselves honestly so upstreams can contact the operator. */
export const USER_AGENT =
  'PHC-Platform/0.1 (Public Health Colosseum opportunity bot; +https://github.com/sciat-solutions)';

/** Refuse to buffer a response large enough to be a memory problem. */
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface GetJsonOptions {
  signal: AbortSignal;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Attempts for transient failures (5xx, 429, network). Default 2. */
  attempts?: number;
}

/**
 * GET a JSON document.
 *
 * Retries only what is worth retrying: 429, 5xx and network errors. A 4xx is
 * a contract problem — retrying it just wastes the upstream's quota, so it
 * fails immediately.
 */
export async function getJson<T>(url: string, options: GetJsonOptions): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 2);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: options.signal,
        redirect: 'follow',
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...options.headers,
        },
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const error = new HttpError(`upstream returned ${response.status}`, response.status, url);
        if (!retryable || attempt === attempts) throw error;
        lastError = error;
        await backoff(attempt, options.signal);
        continue;
      }

      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_RESPONSE_BYTES) {
        throw new HttpError(`response too large (${declared} bytes)`, response.status, url);
      }

      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new HttpError(`response too large (${text.length} bytes)`, response.status, url);
      }

      return JSON.parse(text) as T;
    } catch (cause) {
      // An aborted request means our own timeout fired or shutdown began;
      // retrying would ignore that, so propagate at once.
      if (cause instanceof Error && cause.name === 'AbortError') throw cause;
      if (cause instanceof HttpError && cause.status > 0 && cause.status < 500 && cause.status !== 429) throw cause;
      lastError = cause;
      if (attempt === attempts) break;
      log.debug({ url, attempt, err: String(cause) }, 'retrying upstream request');
      await backoff(attempt, options.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Exponential backoff with jitter, interruptible by the abort signal. */
function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  const delayMs = Math.min(2000, 250 * 2 ** (attempt - 1)) + Math.random() * 150;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Build a URL with query parameters, omitting empty values. */
export function buildUrl(base: string, params: Record<string, string | number | undefined | null>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
