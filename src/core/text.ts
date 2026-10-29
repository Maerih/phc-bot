/**
 * Text utilities shared by the normalisation and rendering layers.
 *
 * Source descriptions arrive as untrusted HTML from third-party APIs, so
 * everything that will be shown to a member passes through `stripHtml` first.
 */

/** Entities common enough in job-board HTML to be worth decoding by hand. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  eacute: 'é',
  uuml: 'ü',
  auml: 'ä',
  ouml: 'ö',
  szlig: 'ß',
};

function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Convert source HTML to plain text suitable for WhatsApp.
 *
 * Block-level tags become newlines and list items become bullets so the shape
 * of the original description survives; everything else is dropped. Script and
 * style bodies are removed before tag stripping so their contents never leak
 * into a message.
 */
/** Does this text still contain something that looks like a real HTML tag? */
const LOOKS_LIKE_MARKUP = /<\/?[a-z][a-z0-9]*\b[^>]*>/i;

function removeTags(input: string): string {
  const withoutDangerousBlocks = input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  return withoutDangerousBlocks
    .replace(/<\s*(br|hr)\s*\/?\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    // `li` is deliberately absent: the opening <li> already starts the line,
    // so closing it too would put a blank line between every bullet.
    .replace(/<\s*\/\s*(p|div|section|article|ul|ol|h[1-6]|tr|table)\s*>/gi, '\n')
    .replace(/<\s*(p|div|section|article|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';

  // Strip, then decode. Doing it the other way round would turn a literal
  // "a &lt; b &gt; c" into "a < b > c" and then delete "< b >" as if it were a tag.
  let text = decodeEntities(removeTags(html));

  // Some feeds deliver HTML that is itself entity-encoded ("&lt;div&gt;…"), so
  // the first decode reveals tags the first strip could not see — which is how
  // raw markup ended up displayed to members. Re-strip only when what came back
  // genuinely looks like markup, so ordinary text containing < or > survives.
  if (LOOKS_LIKE_MARKUP.test(text)) {
    text = decodeEntities(removeTags(text));
  }

  return collapseWhitespace(text);
}

/** Collapse runs of spaces and blank lines while keeping paragraph breaks. */
export function collapseWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Truncate on a word boundary, appending an ellipsis when shortened. */
export function truncate(input: string, maxChars: number): string {
  const text = input.trim();
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Lowercase, accent-folded, punctuation-free form used for keyword matching
 * and de-duplication. Not for display.
 */
export function canonical(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Split a query or description into distinct lowercase word tokens. */
export function tokens(input: string | null | undefined): string[] {
  const canonicalForm = canonical(input);
  if (!canonicalForm) return [];
  return Array.from(new Set(canonicalForm.split(' ').filter((token) => token.length > 1)));
}
