/**
 * Anthropic provider.
 *
 * The only file in the platform that imports the Anthropic SDK. Everything
 * else talks to the `AiProvider` interface, which is what makes the provider
 * swappable by configuration.
 */
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import {
  AiError,
  type AiProvider,
  type CompletionRequest,
  type CompletionResult,
} from '../provider.js';

const log = logger.child({ component: 'ai:anthropic' });

/** Hard ceiling on a single call, so a hung request cannot wedge a command. */
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Default reply budget.
 *
 * Deliberately modest: this is not cost-shaving but a product constraint. A
 * WhatsApp reply that runs to thousands of tokens is unreadable on a phone,
 * and the prompt asks for brevity to match.
 */
const DEFAULT_MAX_TOKENS = 2000;

export function createAnthropicProvider(): AiProvider {
  const apiKey = env.ANTHROPIC_API_KEY.trim();
  if (apiKey.length === 0) {
    throw new AiError('NOT_CONFIGURED', 'ANTHROPIC_API_KEY is not set');
  }

  const client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 2 });
  const model = env.ANTHROPIC_MODEL;

  return {
    name: 'anthropic',
    model,
    supportsWebSearch: true,

    async complete(request: CompletionRequest): Promise<CompletionResult> {
      try {
        const response = await client.messages.create(
          {
            model,
            max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...(request.system ? { system: request.system } : {}),
            messages: request.messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
          },
          request.signal ? { signal: request.signal } : {},
        );

        // A safety decline arrives as a normal 200 response, so it must be
        // checked before the content is read.
        if (response.stop_reason === 'refusal') {
          throw new AiError('REFUSED', 'the model declined to answer');
        }

        // `content` is a discriminated union; only text blocks are rendered.
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim();

        if (text.length === 0) {
          throw new AiError('UPSTREAM', 'the model returned no text');
        }

        return {
          text,
          model: response.model,
          provider: 'anthropic',
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
          stopReason: response.stop_reason ?? undefined,
        };
      } catch (cause) {
        throw normaliseError(cause);
      }
    },

    /**
     * Same call, with Anthropic's server-side web search enabled.
     *
     * `max_uses` is capped deliberately: each search costs money and adds
     * latency, and an unbounded budget turns one member's question into an
     * open-ended crawl.
     */
    async completeWithWebSearch(request: CompletionRequest): Promise<CompletionResult> {
      try {
        const response = await client.messages.create(
          {
            model,
            max_tokens: request.maxTokens ?? 4000,
            ...(request.system ? { system: request.system } : {}),
            messages: request.messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
            tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
          },
          request.signal ? { signal: request.signal } : {},
        );

        if (response.stop_reason === 'refusal') {
          throw new AiError('REFUSED', 'the model declined to answer');
        }

        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim();

        if (text.length === 0) {
          throw new AiError('UPSTREAM', 'the model returned no text');
        }

        return {
          text,
          model: response.model,
          provider: 'anthropic',
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
          stopReason: response.stop_reason ?? undefined,
        };
      } catch (cause) {
        throw normaliseError(cause);
      }
    },
  };
}

/**
 * Map SDK errors onto the platform's own error kinds.
 *
 * Checked most specific first, and using the SDK's typed classes rather than
 * string-matching messages, which break silently when wording changes.
 */
function normaliseError(cause: unknown): AiError {
  if (cause instanceof AiError) return cause;

  if (cause instanceof Error && cause.name === 'AbortError') {
    return new AiError('TIMEOUT', 'the request was aborted', true);
  }

  if (cause instanceof Anthropic.AuthenticationError) {
    // Logged loudly: this is an operator problem, not a member problem.
    log.error('Anthropic rejected the API key — check ANTHROPIC_API_KEY');
    return new AiError('AUTH', 'authentication failed');
  }

  if (cause instanceof Anthropic.RateLimitError) {
    return new AiError('RATE_LIMIT', 'rate limited by the provider', true);
  }

  if (cause instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiError('TIMEOUT', 'the provider timed out', true);
  }

  if (cause instanceof Anthropic.APIError) {
    const retryable = typeof cause.status === 'number' && cause.status >= 500;
    log.warn({ status: cause.status }, 'Anthropic API error');
    return new AiError('UPSTREAM', `provider returned ${cause.status ?? 'an error'}`, retryable);
  }

  log.warn({ err: cause instanceof Error ? cause.message : String(cause) }, 'unexpected AI failure');
  return new AiError('UNKNOWN', 'unexpected failure');
}
