/**
 * DeepSeek, through its OpenAI-compatible chat API.
 *
 * Plain fetch rather than an SDK: one endpoint, one request shape, and no new
 * dependency to install on every server.
 *
 * Docs: https://api-docs.deepseek.com
 */
import { env } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { AiError, type AiProvider, type CompletionRequest, type CompletionResult } from '../provider.js';

const log = logger.child({ component: 'ai:deepseek' });

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MAX_TOKENS = 1024;
const MAX_ATTEMPTS = 3;

interface ChatResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

function classify(status: number, message: string): AiError {
  if (status === 401 || status === 403) return new AiError('AUTH', `DeepSeek rejected the key: ${message}`);
  if (status === 402) return new AiError('AUTH', 'DeepSeek account has no balance left');
  if (status === 429) return new AiError('RATE_LIMIT', 'DeepSeek rate limit', true);
  if (status >= 500) return new AiError('UPSTREAM', `DeepSeek server error ${status}`, true);
  return new AiError('UPSTREAM', `DeepSeek error ${status}: ${message}`);
}

export function createDeepSeekProvider(): AiProvider {
  const apiKey = env.DEEPSEEK_API_KEY.trim();
  if (apiKey.length === 0) throw new AiError('NOT_CONFIGURED', 'DEEPSEEK_API_KEY is not set');
  const model = env.DEEPSEEK_MODEL;

  async function attempt(request: CompletionRequest): Promise<CompletionResult> {
    const messages = [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      ...request.messages.map((message) => ({ role: message.role, content: message.content })),
    ];
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS, stream: false }),
        signal: request.signal ?? AbortSignal.timeout(60_000),
      });
    } catch (cause) {
      const timeout = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
      throw new AiError(timeout ? 'TIMEOUT' : 'UPSTREAM', `DeepSeek request failed: ${String(cause)}`, !timeout);
    }

    const payload = (await response.json().catch(() => ({}))) as ChatResponse;
    if (!response.ok) throw classify(response.status, payload.error?.message ?? response.statusText);

    const text = payload.choices?.[0]?.message?.content?.trim() ?? '';
    if (text.length === 0) throw new AiError('UPSTREAM', 'DeepSeek returned no text');
    return {
      text,
      model: payload.model ?? model,
      provider: 'deepseek',
      ...(payload.usage
        ? { usage: { inputTokens: payload.usage.prompt_tokens ?? 0, outputTokens: payload.usage.completion_tokens ?? 0 } }
        : {}),
      stopReason: payload.choices?.[0]?.finish_reason,
    };
  }

  return {
    name: 'deepseek',
    model,
    supportsWebSearch: false,
    async complete(request) {
      let lastError: AiError | null = null;
      for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
        try {
          return await attempt(request);
        } catch (cause) {
          const error = cause instanceof AiError ? cause : new AiError('UNKNOWN', String(cause));
          if (!error.retryable || n === MAX_ATTEMPTS) throw error;
          lastError = error;
          log.warn({ attempt: n, kind: error.kind }, 'retrying DeepSeek request');
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** n));
        }
      }
      throw lastError ?? new AiError('UNKNOWN', 'exhausted retries');
    },
  };
}
