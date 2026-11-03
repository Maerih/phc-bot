/**
 * Just enough HTML handling for the tracker: the links on a listing page,
 * and the readable text of a listing.
 *
 * Regular expressions rather than a parser dependency: the tracker only needs
 * anchors and visible text, and pages that defeat this are pages whose
 * listings come from JavaScript, which no parser would see either.
 */

export interface PageLink {
  url: string;
  text: string;
  /** Text of the table row or list item around the link, for "View"-style buttons. */
  context: string;
  /** On another site than the page itself — the employer's own page, often. */
  external: boolean;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const value = code[1]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function clean(text: string): string {
  return decodeEntities(text.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** The registrable-ish part of a host, so www.x.co.ke and jobs.x.co.ke match. */
export function siteKey(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.');
  // Two-part public suffixes common here: co.ke, go.ke, or.ke, ac.ke, co.uk, org.uk…
  const twoPart = parts.length >= 3 && /^(co|go|or|ac|ne|org|gov|com|edu)$/.test(parts[parts.length - 2] ?? '');
  return parts.slice(twoPart ? -3 : -2).join('.');
}

/** Text of the innermost table row, list item or article around a position. */
function surrounding(html: string, index: number): string {
  for (const tag of ['tr', 'li', 'article']) {
    const open = html.lastIndexOf(`<${tag}`, index);
    if (open < 0 || html.lastIndexOf(`</${tag}>`, index) > open) continue;
    const close = html.indexOf(`</${tag}>`, index);
    if (close < 0 || close - open > 5000) continue;
    return clean(html.slice(open, close));
  }
  return '';
}

export function extractLinks(html: string, baseUrl: string): PageLink[] {
  const base = new URL(baseUrl);
  const baseKey = siteKey(base.hostname);
  const seen = new Set<string>();
  const links: PageLink[] = [];

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attributes = match[1] ?? '';
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href.trim())) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(href.trim()), base);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    url.hash = '';
    const text = clean(match[2] ?? '') || clean(/title\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1] ?? '');
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      url: key,
      text,
      context: text.length < 15 ? surrounding(html, match.index ?? 0) : '',
      external: siteKey(url.hostname) !== baseKey,
    });
  }
  return links;
}

/** Navigation, sharing and account links — never listings. */
const NOT_A_LISTING =
  /\/(category|categories|tag|tags|page|author|login|log-in|signin|sign-in|register|signup|sign-up|account|privacy|privacy-policy|terms|cookie|cookies|contact|contact-us|about|about-us|faq|search|feed|wp-login\.php|cart|checkout|subscribe)(\/|$|\?)/i;
const SHARE_HOSTS = /(facebook|twitter|x|linkedin|whatsapp|t|telegram|instagram|youtube|tiktok|pinterest)\.(com|me)$/i;
const NAV_TEXT =
  /^(home|next|previous|prev|more|read more|view more|see more|load more|apply now|apply|details|view details|view job|show more|login|register|sign in|sign up|contact us|about us|all jobs|browse jobs|post a job|subscribe)$/i;

/**
 * A title read from a table row carries the row's other cells: reference
 * codes, closing dates and times, grades. Keep the words that name the job.
 */
export function tidyRowTitle(text: string): string {
  return text
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}(:?\s*\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?)?/gi, ' ')
    .replace(/^\s*[A-Z]{1,5}[-/]?\d{3,}\s+/, '')
    .replace(/\b[A-Z]{2,4}\s?\d{1,2}\s*$/, '')
    .replace(/_/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

const BUTTON_WORDS = /\b(view( job)?( details)?|apply( now)?|details|read more|more info|download)\b/gi;

/** Links on a listing page that look like individual opportunities. */
export function listingCandidates(html: string, pageUrl: string, max = 200): PageLink[] {
  const pagePath = new URL(pageUrl).pathname.replace(/\/$/, '');
  return extractLinks(html, pageUrl)
    .map((link) => {
      // A "View" or "Apply Now" button: the listing's title is in its row.
      if (link.text.length >= 15 || !link.context) return link;
      const fromRow = tidyRowTitle(link.context.replace(BUTTON_WORDS, ' '));
      return { ...link, text: fromRow.slice(0, 200) };
    })
    .filter((link) => {
      if (link.external) return false;
      if (link.text.length < 15 || link.text.length > 200) return false;
      if (NAV_TEXT.test(link.text)) return false;
      const url = new URL(link.url);
      if (SHARE_HOSTS.test(url.hostname)) return false;
      if (NOT_A_LISTING.test(url.pathname)) return false;
      const path = url.pathname.replace(/\/$/, '');
      // The page itself, the site root, or a parent of the page: navigation.
      if (path === '' || path === pagePath || pagePath.startsWith(`${path}/`)) return false;
      return true;
    })
    .slice(0, max);
}

/** Readable text of a page: scripts, styles and navigation chrome removed. */
export function htmlToText(html: string, maxChars = 8000): string {
  const body = (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html)
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n');
  return decodeEntities(body.replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
}
