/**
 * The AI provider contract.
 *
 * Business logic depends on this interface and never on a vendor SDK, so
 * switching between Anthropic and OpenAI is a configuration change rather than
 * a rewrite. Every concrete provider lives in its own directory under `ai/`.
 */

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  /** Instructions that frame the task. Never member-supplied. */
  system?: string;
  messages: AiMessage[];
  /** Upper bound on the reply. Defaults are set per call site. */
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  /** Model that actually served the request, which may differ from the request. */
  model: string;
  provider: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** Why generation stopped. 'refusal' is handled explicitly by callers. */
  stopReason?: string;
}

export interface AiProvider {
  /** Stable identifier used in config, logs and analytics. */
  readonly name: string;
  readonly model: string;
  /** True when the provider can search the live web server-side. */
  readonly supportsWebSearch: boolean;
  complete(request: CompletionRequest): Promise<CompletionResult>;
  /**
   * Answer using a live web search.
   *
   * Present only when `supportsWebSearch` is true. The search runs on the
   * provider's infrastructure, so the platform needs no browser or scraper of
   * its own — and the model answers from pages that actually exist rather than
   * from memory, which is the whole point when the question is "what is open
   * right now".
   */
  completeWithWebSearch?(request: CompletionRequest): Promise<CompletionResult>;
}

/**
 * Errors a provider may raise, normalised so callers never have to know which
 * vendor SDK threw. The kind decides what the member is told.
 */
export type AiErrorKind =
  | 'NOT_CONFIGURED'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'REFUSED'
  | 'UPSTREAM'
  | 'UNKNOWN';

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/** Member-facing text for a failure. Never leaks provider internals or keys. */
export function describeAiError(error: AiError): string {
  switch (error.kind) {
    case 'NOT_CONFIGURED':
      return 'The assistant is not switched on for this community yet.';
    case 'AUTH':
      return 'The assistant is misconfigured. An administrator has been notified.';
    case 'RATE_LIMIT':
      return 'The assistant is busy right now. Please try again in a minute.';
    case 'TIMEOUT':
      return 'That took too long to answer. Try a shorter or simpler question.';
    case 'REFUSED':
      return 'I am not able to answer that one. Try rephrasing, or ask something else.';
    default:
      return 'The assistant could not answer just now. Please try again shortly.';
  }
}
