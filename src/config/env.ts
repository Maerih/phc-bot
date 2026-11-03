/**
 * Environment configuration — validated once, at startup.
 *
 * Everything the platform reads from the environment is declared here and
 * nowhere else. If a required variable is missing or malformed the process
 * exits immediately with a readable message rather than failing later in a
 * request handler.
 */
import 'dotenv/config';
import { z } from 'zod';

/** Comma-separated list -> trimmed, de-duplicated, empty entries dropped. */
const csv = z
  .string()
  .default('')
  .transform((raw) =>
    Array.from(
      new Set(
        raw
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0),
      ),
    ),
  );

/** Digits-only phone numbers (international format, no "+"). */
const phoneList = csv.pipe(z.array(z.string().regex(/^\d{6,20}$/, 'phone numbers must be digits only, no "+"')));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3100),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  TIMEZONE: z.string().default('Africa/Nairobi'),

  DATABASE_URL: z.string().url('DATABASE_URL must be a valid postgres:// connection string'),

  WHATSAPP_PROVIDER: z.enum(['baileys']).default('baileys'),
  WHATSAPP_AUTH_DIR: z.string().default('./auth'),
  WHATSAPP_PAIR_NUMBER: z
    .string()
    .default('')
    .refine((v) => v === '' || /^\d{6,20}$/.test(v), 'WHATSAPP_PAIR_NUMBER must be digits only, no "+"'),

  COMMAND_PREFIX: z.string().min(1).max(3).default('.'),

  ADMIN_NUMBERS: phoneList,

  /**
   * Token guarding the browser pairing page.
   *
   * Required to expose it at all. A WhatsApp QR is a credential: whoever scans
   * it binds the bot to their account, so an unguarded pairing page lets a
   * stranger take the deployment over. Blank keeps the page disabled.
   */
  ADMIN_PANEL_TOKEN: z.string().default(''),
  /**
   * The browser pairing page is for hosts with no terminal (shared hosting).
   * Off by default: on a server, pair from the terminal (`./ctl.sh pair`), so
   * no web page ever shows the QR. Needs ADMIN_PANEL_TOKEN as well.
   */
  PAIRING_PAGE: z.enum(['on', 'off']).default('off'),

  // Gemini is the default: Google AI Studio issues a free key with a usable
  // free tier and built-in search grounding, so the AI features work without
  // a billing account. The others stay available for later.
  AI_PROVIDER: z.enum(['auto', 'gemini', 'anthropic', 'openai', 'deepseek', 'none']).default('auto'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),
  /**
   * DeepSeek: used by the site tracker to pick public-health listings out of
   * what it finds, whatever AI_PROVIDER answers .ask. Also selectable as the
   * main provider with AI_PROVIDER=deepseek.
   */
  DEEPSEEK_API_KEY: z.string().default(''),
  DEEPSEEK_MODEL: z.string().default('deepseek-chat'),
  /**
   * JSearch on RapidAPI: daily public-health job searches across the big job
   * indexes, LinkedIn's postings included. Free plan: ~200 requests a month.
   */
  JSEARCH_API_KEY: z.string().default(''),
  /** Watch the listed opportunity websites and announce new public-health finds. */
  TRACKER_ENABLED: z.enum(['on', 'off']).default('on'),
  /** Minutes between checks of each site. */
  TRACKER_INTERVAL_MINUTES: z.coerce.number().int().min(10).max(1440).default(30),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),

  /**
   * Where the opportunity fallback gets its web results.
   *   tavily   - free tier, key from https://app.tavily.com/
   *   searxng  - a SearXNG instance you host; no key, no quota
   *   provider - the AI provider's own grounded search (billed by them)
   *   none     - no web fallback
   */
  WEB_SEARCH_PROVIDER: z.enum(['tavily', 'searxng', 'provider', 'none']).default('none'),
  TAVILY_API_KEY: z.string().default(''),
  SEARXNG_URL: z.string().default(''),

  SOURCES_ENABLED: csv,
  RELIEFWEB_APPNAME: z.string().default(''),
  /** Greenhouse board tokens, one per organisation. */
  GREENHOUSE_BOARDS: csv,
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // Written to stderr directly: the logger itself depends on this config.
  process.stderr.write(`\nInvalid environment configuration:\n${issues}\n\nSee .env.example for the expected values.\n\n`);
  process.exit(1);
}

export const env = Object.freeze(parsed.data);

export type Env = typeof env;

/** True when an AI provider is both selected and actually credentialed. */
export function isAiConfigured(): boolean {
  if (env.AI_PROVIDER === 'none') return false;
  // Any key will do: the router falls back to whichever provider has one.
  if ([env.DEEPSEEK_API_KEY, env.GEMINI_API_KEY, env.ANTHROPIC_API_KEY].some((key) => key.trim().length > 0)) return true;
  if (env.AI_PROVIDER === 'gemini') return env.GEMINI_API_KEY.length > 0;
  if (env.AI_PROVIDER === 'anthropic') return env.ANTHROPIC_API_KEY.length > 0;
  if (env.AI_PROVIDER === 'openai') return env.OPENAI_API_KEY.length > 0;
  if (env.AI_PROVIDER === 'deepseek') return env.DEEPSEEK_API_KEY.length > 0;
  return false;
}
