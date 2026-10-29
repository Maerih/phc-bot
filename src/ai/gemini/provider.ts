/**
 * Google Gemini provider — the default.
 *
 * Chosen as the default because Google AI Studio issues a free API key with a
 * usable free tier, and Gemini has Google Search grounding built in. That
 * combination is what makes the opportunity web-fallback viable for a
 * community platform with no budget: live search, at no running cost.
 *
 * The only file in the platform that imports the Google GenAI SDK. Everything
 * else depends on the `AiProvider` interface, so swapping to Anthropic or
 * OpenAI later is a change to `AI_PROVIDER`, not to any business logic.
 */
import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import {
  AiError,
  type AiProvider,
  type CompletionRequest,
  type CompletionResult,
} from '../provider.js';

const log = logger.child({ component: 'ai:gemini' });

const DEFAULT_MAX_TOKENS = 2000;

/**
 * Floor on the output budget.
 *
 * Gemini's flash models reason before answering, and those thinking tokens come
 * out of `maxOutputTokens`. A small budget is therefore consumed entirely by
 * reasoning and the call returns a valid response with no text at all — which
 * looks exactly like a failure. 1024 leaves room for both.
 */
const MIN_OUTPUT_TOKENS = 1024;

/**
 * Retries for transient failures.
 *
 * Gemini returns 503 "high demand" and 429 often enough that a single attempt
 * makes the whole feature look broken. These are explicitly marked retryable
 * by `normaliseError`; everything else fails fast, because retrying an auth
 * error or a bad model name just wastes time.
 */
const MAX_ATTEMPTS = 3;

function backoffMs(attempt: number): number {
  return Math.min(4000, 600 * 2 ** (attempt - 1)) + Math.random() * 250;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Gemini takes a flat conversation; our two-role shape maps directly. */
function toContents(request: CompletionRequest) {
  return request.messages.map((message) => ({
    // Gemini calls the assistant role "model".
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }));
}

export function createGeminiProvider(): AiProvider {
  const apiKey = env.GEMINI_API_KEY.trim();
  if (apiKey.length === 0) {
    throw new AiError('NOT_CONFIGURED', 'GEMINI_API_KEY is not set');
  }

  const client = new GoogleGenAI({ apiKey });
  const model = env.GEMINI_MODEL;

  /** Shared call path; `useSearch` adds Google Search grounding. */
  async function generate(request: CompletionRequest, useSearch: boolean): Promise<CompletionResult> {
    let lastError: AiError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await attemptGenerate(request, useSearch);
      } catch (cause) {
        const error = cause instanceof AiError ? cause : new AiError('UNKNOWN', String(cause));
        if (!error.retryable || attempt === MAX_ATTEMPTS) throw error;
        lastError = error;
        log.warn({ attempt, kind: error.kind }, 'retrying Gemini request');
        await delay(backoffMs(attempt), request.signal);
      }
    }

    throw lastError ?? new AiError('UNKNOWN', 'exhausted retries');
  }

  async function attemptGenerate(request: CompletionRequest, useSearch: boolean): Promise<CompletionResult> {
    try {
      const response = await client.models.generateContent({
        model,
        contents: toContents(request),
        config: {
          maxOutputTokens: Math.max(request.maxTokens ?? DEFAULT_MAX_TOKENS, MIN_OUTPUT_TOKENS),
          ...(request.system ? { systemInstruction: request.system } : {}),
          ...(request.signal ? { abortSignal: request.signal } : {}),
          // Grounding runs on Google's side, so the platform needs no browser
          // or scraper of its own.
          ...(useSearch ? { tools: [{ googleSearch: {} }] } : {}),
        },
      });

      const text = response.text?.trim() ?? '';
      if (text.length === 0) {
        // A valid response with no text means the budget went entirely on
        // reasoning, or a safety filter removed the answer.
        throw new AiError(
          'UPSTREAM',
          'the model returned no text (the output budget may have gone entirely on reasoning)',
        );
      }

      const usage = response.usageMetadata;

      return {
        text,
        model,
        provider: 'gemini',
        ...(usage
          ? {
              usage: {
                inputTokens: usage.promptTokenCount ?? 0,
                outputTokens: usage.candidatesTokenCount ?? 0,
              },
            }
          : {}),
      };
    } catch (cause) {
      throw normaliseError(cause);
    }
  }

  return {
    name: 'gemini',
    model,
    supportsWebSearch: true,
    complete: (request) => generate(request, false),
    completeWithWebSearch: (request) => generate(request, true),
  };
}

/** Read an HTTP status off whatever shape the SDK threw. */
function statusOf(cause: unknown): number | null {
  if (typeof cause !== 'object' || cause === null) return null;
  const record = cause as Record<string, unknown>;
  for (const key of ['status', 'code', 'statusCode']) {
    const value = record[key];
    if (typeof value === 'number') return value;
  }
  return null;
}

/**
 * Map SDK failures onto the platform's own error kinds.
 *
 * The Google SDK does not export typed error classes the way the Anthropic one
 * does, so this reads the status off the thrown object and falls back to a
 * narrow message check — deliberately narrow, because broad string matching
 * breaks silently when wording changes.
 */
function normaliseError(cause: unknown): AiError {
  if (cause instanceof AiError) return cause;

  if (cause instanceof Error && cause.name === 'AbortError') {
    return new AiError('TIMEOUT', 'the request was aborted', true);
  }

  const status = statusOf(cause);
  const message = cause instanceof Error ? cause.message : String(cause);

  if (status === 401 || status === 403) {
    log.error('Google rejected the API key — check GEMINI_API_KEY');
    return new AiError('AUTH', 'authentication failed');
  }
  if (status === 429) {
    return new AiError('RATE_LIMIT', 'rate limited by the provider', true);
  }
  if (status !== null && status >= 500) {
    // Logged: a silent 5xx made the whole fallback look broken for no visible
    // reason, which is exactly the kind of failure that wastes an afternoon.
    log.warn({ status, err: message.slice(0, 160) }, 'Gemini upstream error (will retry)');
    return new AiError('UPSTREAM', `provider returned ${status}`, true);
  }
  if (status === 400 && /api[_ ]?key/i.test(message)) {
    log.error('Google rejected the API key — check GEMINI_API_KEY');
    return new AiError('AUTH', 'authentication failed');
  }
  if (status === 404) {
    // Almost always a model name the account cannot use.
    log.error({ model: env.GEMINI_MODEL }, 'Gemini model not found — check GEMINI_MODEL');
    return new AiError('UPSTREAM', 'the configured model is unavailable');
  }
  if (/safety|blocked/i.test(message)) {
    return new AiError('REFUSED', 'the model declined to answer');
  }

  log.warn({ status, err: message }, 'unexpected Gemini failure');
  return new AiError('UNKNOWN', 'unexpected failure');
}
