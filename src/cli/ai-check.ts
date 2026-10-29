/**
 * Verify the configured AI provider actually works.
 *
 *   npm run ai:check
 *
 * Exists because the two things most likely to be wrong — a bad key and an
 * unavailable model name — both surface only on a real call. Finding that out
 * from a one-second diagnostic is far better than finding it out from a member
 * whose question silently failed.
 *
 * Makes two calls: a plain completion, then one with web search. The second is
 * what the opportunity fallback depends on.
 */
import { env, isAiConfigured } from '../config/env.js';
import { getAiProvider } from '../ai/router.js';
import { AiError, describeAiError } from '../ai/provider.js';

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(22)} ${value}\n`);
}

async function main(): Promise<void> {
  process.stdout.write('\nAI configuration\n');
  line('AI_PROVIDER', env.AI_PROVIDER);
  line('Key present', isAiConfigured() ? 'yes' : 'NO');

  const provider = getAiProvider();
  if (!provider) {
    process.stdout.write(
      '\nNo AI provider is active.\n' +
        `  AI_PROVIDER is "${env.AI_PROVIDER}" and no matching API key is set.\n\n` +
        '  For the free option, get a key at https://aistudio.google.com/apikey\n' +
        '  then set in .env:\n\n' +
        '    AI_PROVIDER=gemini\n' +
        '    GEMINI_API_KEY=your-key\n\n' +
        '  Everything else keeps working without it.\n\n',
    );
    process.exit(1);
  }

  line('Provider', provider.name);
  line('Model', provider.model);
  line('Web search', provider.supportsWebSearch ? 'supported' : 'not supported');

  // 1. Plain completion.
  process.stdout.write('\nTesting a plain completion...\n');
  try {
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      // Thinking models spend part of this budget before answering.
      maxTokens: 800,
    });
    line('Reply', result.text.slice(0, 60));
    line('Tokens', `${result.usage?.inputTokens ?? '?'} in / ${result.usage?.outputTokens ?? '?'} out`);
    process.stdout.write('  PASS\n');
  } catch (cause) {
    const error = cause instanceof AiError ? cause : new AiError('UNKNOWN', String(cause));
    process.stdout.write(`  FAIL (${error.kind}) — ${error.message}\n`);
    process.stdout.write(`  Members would see: "${describeAiError(error)}"\n\n`);
    process.exit(1);
  }

  // 2. Web search, which the opportunity fallback depends on.
  if (!provider.completeWithWebSearch) {
    process.stdout.write('\nWeb search not supported by this provider; the opportunity fallback will not run.\n\n');
    return;
  }

  process.stdout.write('\nTesting a live web search...\n');
  try {
    const result = await provider.completeWithWebSearch({
      messages: [
        {
          role: 'user',
          content: 'Search the web and reply in one short sentence with one current public health news headline.',
        },
      ],
      maxTokens: 300,
    });
    line('Reply', result.text.slice(0, 120));
    process.stdout.write('  PASS — the opportunity web fallback will work.\n\n');
  } catch (cause) {
    const error = cause instanceof AiError ? cause : new AiError('UNKNOWN', String(cause));
    process.stdout.write(`  FAIL (${error.kind}) — ${error.message}\n`);
    process.stdout.write('  Plain questions will work; the opportunity web fallback will not.\n\n');
    process.exit(1);
  }
}

main().catch((cause) => {
  process.stderr.write(`\nai:check failed: ${cause instanceof Error ? cause.stack : String(cause)}\n`);
  process.exit(1);
});
