/**
 * What a message contains, judged from its text alone.
 *
 * Pure functions with no I/O, so every rule is unit-tested against real-world
 * examples. The communities this serves share opportunities — job links,
 * stipends, deadlines — so each rule is tuned to leave those alone: a link to
 * a vacancy is the point of the group, a link to someone else's WhatsApp group
 * is not.
 */

// ── Links ────────────────────────────────────────────────────────────────────

/** Hosts whose links pull members somewhere else: other groups, channels, DMs. */
const INVITE_PATTERNS: RegExp[] = [
  /(?:^|\.)chat\.whatsapp\.com$/,
  /(?:^|\.)wa\.me$/,
  /(?:^|\.)t\.me$/,
  /(?:^|\.)telegram\.(?:me|dog)$/,
  /(?:^|\.)discord\.(?:gg|com)$/,
];

/** whatsapp.com itself only counts for channel links, not its help pages. */
const WHATSAPP_CHANNEL = /^(?:www\.)?whatsapp\.com\/channel\//;

// Bare domains (no scheme) are only recognised with a known top-level domain,
// so "e.g." or "Ph.D." is never mistaken for a link.
const BARE_TLDS =
  'com|net|org|info|biz|io|co|me|ly|gl|gg|xyz|top|site|online|shop|store|link|club|app|live|' +
  'ke|ug|tz|rw|ng|gh|za|et|uk|us|in|tk|ml|ga|cf|gq';

const LINK_RE = new RegExp(
  String.raw`\b(?:(?:https?:\/\/|www\.)[^\s<>"'()]+|(?:[a-z0-9-]+\.)+(?:${BARE_TLDS})(?:\/[^\s<>"'()]*)?)`,
  'gi',
);

export interface LinkFindings {
  /** Invite and contact links: other WhatsApp groups and channels, Telegram, wa.me. */
  invites: string[];
  /** Every other link, minus allowed domains. */
  external: string[];
}

function hostAndPath(link: string): { host: string; rest: string } {
  const withoutScheme = link.replace(/^https?:\/\//i, '').toLowerCase();
  const slash = withoutScheme.indexOf('/');
  const host = (slash === -1 ? withoutScheme : withoutScheme.slice(0, slash)).replace(/^www\./, '');
  return { host: host.replace(/[.,;:!?]+$/, ''), rest: withoutScheme };
}

/** Does this host fall under an allowed domain (the domain itself or a subdomain)? */
function isAllowed(host: string, allowedDomains: readonly string[]): boolean {
  return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function findLinks(text: string, allowedDomains: readonly string[] = []): LinkFindings {
  const invites: string[] = [];
  const external: string[] = [];

  for (const match of text.matchAll(LINK_RE)) {
    const link = match[0];
    const { host, rest } = hostAndPath(link);
    if (host.length === 0) continue;

    if (INVITE_PATTERNS.some((pattern) => pattern.test(host)) || WHATSAPP_CHANNEL.test(rest)) {
      invites.push(link);
    } else if (!isAllowed(host, allowedDomains)) {
      external.push(link);
    }
  }

  return { invites, external };
}

/** Normalise what an admin typed as a domain: "https://www.Who.int/x" → "who.int". */
export function normaliseDomain(raw: string): string | null {
  const { host } = hostAndPath(raw.trim());
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

// ── Adverts and promotions ───────────────────────────────────────────────────

interface Signal {
  pattern: RegExp;
  weight: number;
  label: string;
}

/**
 * Phrases that mark selling, money schemes and self-promotion.
 *
 * Deliberately specific: "loan" alone would catch "student loan forgiveness",
 * and "investment" would catch "investment in health systems". These are the
 * shapes spam actually takes in East African WhatsApp groups.
 */
const PROMO_SIGNALS: Signal[] = [
  { pattern: /\b(?:dm|inbox|pm|whatsapp|text|call)\s+(?:me|us)\b/, weight: 3, label: 'asks for private contact' },
  { pattern: /\bcall\s*(?:\/|or|&)\s*whatsapp\b/, weight: 3, label: 'asks for private contact' },
  { pattern: /\b(?:i|we)\s+(?:sell|deal\s+in|supply|offer\s+affordable)\b/, weight: 3, label: 'selling' },
  { pattern: /\bfor\s+sale\b|\bselling\b/, weight: 2, label: 'selling' },
  { pattern: /\b(?:buy|order|shop)\s+(?:now|today|yours)\b/, weight: 3, label: 'sales pitch' },
  { pattern: /\b(?:discount|promo\s*code|limited\s+offer|mega\s+offer|special\s+offer|flash\s+sale)\b|\d+\s?%\s?off\b/, weight: 3, label: 'sales pitch' },
  { pattern: /\b(?:free|fast|same[- ]day)\s+delivery\b|\bcash\s+on\s+delivery\b|\bwe\s+deliver\b/, weight: 3, label: 'sales pitch' },
  { pattern: /\b(?:affordable|cheap|wholesale|best\s+prices?|in\s+stock|original\s+quality)\b/, weight: 2, label: 'sales pitch' },
  { pattern: /\bearn\b.{0,40}\b(?:daily|per\s+day|a\s+day|weekly|per\s+week|from\s+(?:your\s+)?(?:home|phone))\b/, weight: 3, label: 'money scheme' },
  { pattern: /\b(?:make|making)\s+money\b|\bpassive\s+income\b|\bget\s+rich\b|\bdouble\s+your\b/, weight: 3, label: 'money scheme' },
  { pattern: /\b(?:forex|crypto|bitcoin|binary\s+options?|trading\s+signals?|betting\s+tips|fixed\s+matches|jackpot\s+tips)\b/, weight: 3, label: 'money scheme' },
  { pattern: /\b(?:instant|quick|fast|easy)\s+loans?\b|\bloans?\s+available\b|\bloan\s+app\b/, weight: 3, label: 'money scheme' },
  { pattern: /\b(?:followers|subscribers|likes|views)\b.{0,30}\b(?:buy|boost|increase|grow|cheap)\b|\b(?:buy|boost|increase|grow)\b.{0,30}\b(?:followers|subscribers|likes|views)\b/, weight: 3, label: 'social-media boosting' },
  { pattern: /\b(?:join|follow|subscribe\s+to)\s+(?:my|our)\s+(?:vip\s+)?(?:channel|group|page|telegram)\b|\bvip\s+(?:channel|group)\b/, weight: 3, label: 'self-promotion' },
  { pattern: /\blink\s+in\s+(?:my\s+)?bio\b|\bclick\s+(?:the\s+link|here|below)\b/, weight: 2, label: 'self-promotion' },
  { pattern: /\b(?:hookups?|sugar\s+(?:mummy|daddy)|adult\s+content|18\+)\b/, weight: 4, label: 'adult content' },
  { pattern: /(?:\b(?:ksh|kes|ugx|tzs|tsh|ngn|usd)\.?\s?\d[\d,]*|[$€£₦]\s?\d[\d,]*|\b\d[\d,]*\s?(?:\/=|bob\b))/, weight: 2, label: 'mentions a price' },
];

/** Context that real opportunity posts carry and adverts rarely do. */
const OPPORTUNITY_CONTEXT =
  /\b(?:scholarships?|fellowships?|internships?|vacanc(?:y|ies)|job\s+(?:opening|opportunity|advert)|apply\s+(?:by|before|here|now|online)|applications?\s+(?:open|close|deadline)|deadline|webinar|conference|call\s+for\s+(?:applications|abstracts|proposals)|grants?|stipend|research\s+assistant)\b/;

const PHONE_RE = /(?:\+?254|\b0)\s?[17]\d{2}\s?\d{3}\s?\d{3}\b|\+\d{10,14}\b/;

export interface PromoAssessment {
  score: number;
  reasons: string[];
}

/** Score ≥ this: an advert. Between REVIEW and this: ask the AI, if allowed. */
export const PROMO_THRESHOLD = 5;
export const PROMO_REVIEW_THRESHOLD = 3;

export function assessPromotion(text: string, options: { forwardingScore?: number } = {}): PromoAssessment {
  const lower = text.toLowerCase();
  const reasons = new Set<string>();
  let score = 0;

  for (const signal of PROMO_SIGNALS) {
    if (signal.pattern.test(lower)) {
      score += signal.weight;
      reasons.add(signal.label);
    }
  }

  if (PHONE_RE.test(text)) {
    score += 1;
    reasons.add('phone number');
  }

  const { invites, external } = findLinks(text);
  if (invites.length > 0) {
    score += 2;
    reasons.add('invite link');
  } else if (external.length > 0) {
    score += 1;
  }

  // Forwarded "many times" is WhatsApp's own chain-message flag. Opportunity
  // posts get forwarded too, so it only nudges.
  if ((options.forwardingScore ?? 0) >= 5) score += 1;

  // Shouting: a long message that is mostly capitals.
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 30 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.6) {
    score += 1;
  }

  if (OPPORTUNITY_CONTEXT.test(lower)) score -= 2;

  return { score, reasons: [...reasons] };
}

// ── Banned words ─────────────────────────────────────────────────────────────

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

function normaliseForMatching(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[013457@$]/g, (char) => LEET[char] ?? char);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The first banned word or phrase the text contains, or null.
 *
 * Matches whole words, so "ass" never fires on "class" and "crypto" never
 * fires on "cryptography". Entries of four letters or more also match with
 * separators between the letters, which catches "l.o.a.n" and "c r y p t o".
 */
export function findBannedWord(text: string, bannedWords: readonly string[]): string | null {
  if (bannedWords.length === 0) return null;
  const normalised = normaliseForMatching(text);

  for (const word of bannedWords) {
    const target = normaliseForMatching(word).trim();
    if (target.length === 0) continue;

    const letters = target.replace(/[^a-z]/g, '');
    const body =
      letters.length >= 4
        ? letters.split('').join('[^a-z]*')
        : target.split(/\s+/).map(escapeRegex).join('\\s+');
    if (new RegExp(`(?:^|[^a-z])${body}(?:$|[^a-z])`).test(normalised)) return word;
  }
  return null;
}

// ── Repetition ───────────────────────────────────────────────────────────────

/**
 * A fingerprint for "the same message again": case, spacing, punctuation and
 * emoji ignored. Null for short messages, which repeat innocently ("thanks",
 * "amen", "noted").
 */
export function fingerprint(text: string): string | null {
  const core = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return core.length >= 20 ? core : null;
}
