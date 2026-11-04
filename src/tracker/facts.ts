/**
 * Facts a listing page states about itself, read deterministically before
 * any AI is involved.
 *
 * Most job boards embed schema.org JobPosting data (title, employer, posting
 * date, closing date, salary, location, contact); most other pages carry at
 * least a publication date. These are far more reliable than a model's
 * reading of the text, so they win whenever both exist.
 */
import { decodeEntities } from './html.js';

export interface PageFacts {
  title: string | null;
  organization: string | null;
  /** YYYY-MM-DD */
  posted: string | null;
  /** YYYY-MM-DD */
  deadline: string | null;
  location: string | null;
  salary: string | null;
  employmentType: string | null;
  emails: string[];
  /** The page itself says the opportunity is closed or expired. */
  closed: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Any common date shape → YYYY-MM-DD, or null. Day-first for numeric dates, as in Kenya. */
export function toIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (match) return valid(+match[1]!, +match[2]!, +match[3]!);
  match = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/.exec(text);
  if (match) return valid(+match[3]!, MONTHS[match[2]!.slice(0, 4).toLowerCase()] ?? MONTHS[match[2]!.slice(0, 3).toLowerCase()] ?? 0, +match[1]!);
  match = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(text);
  if (match) return valid(+match[3]!, MONTHS[match[1]!.slice(0, 4).toLowerCase()] ?? MONTHS[match[1]!.slice(0, 3).toLowerCase()] ?? 0, +match[2]!);
  match = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/.exec(text);
  if (match) return valid(+match[3]!, +match[2]!, +match[1]!);
  return null;
}

function valid(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  return date.toISOString().slice(0, 10);
}

function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed: unknown = JSON.parse(match[1]!.trim());
      const stack = [parsed];
      while (stack.length > 0) {
        const value = stack.pop();
        if (Array.isArray(value)) stack.push(...value);
        else if (value && typeof value === 'object') {
          blocks.push(value);
          const graph = (value as Record<string, unknown>)['@graph'];
          if (Array.isArray(graph)) stack.push(...graph);
        }
      }
    } catch {
      // Malformed JSON-LD is common; skip it.
    }
  }
  return blocks;
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return decodeEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (value && typeof value === 'object' && 'name' in value) return str((value as { name: unknown }).name);
  return null;
}

function locationOf(value: unknown): string | null {
  const places = Array.isArray(value) ? value : [value];
  const names = places.flatMap((place) => {
    const address = (place as { address?: unknown } | null)?.address;
    if (typeof address === 'string') return [address];
    if (address && typeof address === 'object') {
      const a = address as Record<string, unknown>;
      const parts = [a.addressLocality, a.addressRegion, str(a.addressCountry)].map((part) => str(part)).filter(Boolean);
      return parts.length > 0 ? [parts.join(', ')] : [];
    }
    return [];
  });
  return names.length > 0 ? [...new Set(names)].join('; ') : null;
}

function salaryOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return str(value);
  const salary = value as { currency?: unknown; value?: unknown };
  const amount = salary.value as { minValue?: unknown; maxValue?: unknown; value?: unknown; unitText?: unknown } | undefined;
  if (!amount || typeof amount !== 'object') return null;
  const format = (n: unknown): string | null => (typeof n === 'number' && n > 0 ? n.toLocaleString('en-US') : typeof n === 'string' && n.trim() ? n.trim() : null);
  const min = format(amount.minValue ?? amount.value);
  const max = format(amount.maxValue);
  if (!min && !max) return null;
  const range = min && max && min !== max ? `${min} – ${max}` : (min ?? max);
  const unit = typeof amount.unitText === 'string' ? ` per ${amount.unitText.toLowerCase()}` : '';
  return `${typeof salary.currency === 'string' ? `${salary.currency} ` : ''}${range}${unit}`;
}

/** Email addresses in visible text and mailto links, minus obvious site boilerplate. */
export function emailsIn(html: string): string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/(?:mailto:)?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
    const email = match[1]!.toLowerCase().replace(/[.,;:]+$/, '');
    if (/\.(png|jpe?g|gif|webp|svg)$/.test(email)) continue;
    if (/^(noreply|no-reply|example|user|name|email|your|info@example)/.test(email)) continue;
    if (/(sentry|wixpress|cloudflare|wordpress|schema\.org|w3\.org|gravatar)/.test(email)) continue;
    found.add(email);
  }
  return [...found].slice(0, 10);
}

const DEADLINE_TEXT =
  /(?:deadline|closing date|close[sd]? on|applications? (?:close|should be (?:sent|submitted|received)|must reach)[^.]{0,40}?(?:by|before|on|not later than)|apply (?:by|before|not later than)|not later than|on or before|expires? on)[:\s-]*((?:\w+day,?\s+)?(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?[A-Za-z]{3,9}\.?,?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{4}-\d{2}-\d{2}))/i;

/** What the page says about itself. */
export function extractPageFacts(html: string, text: string): PageFacts {
  const facts: PageFacts = {
    title: null,
    organization: null,
    posted: null,
    deadline: null,
    location: null,
    salary: null,
    employmentType: null,
    emails: [],
    closed: false,
  };

  const blocks = jsonLdBlocks(html) as Array<Record<string, unknown>>;
  const job = blocks.find((block) => {
    const type = block['@type'];
    return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
  });
  if (job) {
    facts.title = str(job.title);
    facts.organization = str(job.hiringOrganization);
    facts.posted = toIsoDate(str(job.datePosted));
    facts.deadline = toIsoDate(str(job.validThrough));
    facts.location = locationOf(job.jobLocation) ?? (job.jobLocationType === 'TELECOMMUTE' ? 'Remote' : null);
    facts.salary = salaryOf(job.baseSalary);
    facts.employmentType = Array.isArray(job.employmentType) ? job.employmentType.join(', ') : str(job.employmentType);
    const contact = job.applicationContact as Record<string, unknown> | undefined;
    if (contact && typeof contact.email === 'string') facts.emails.push(contact.email.toLowerCase());
  }

  if (!facts.posted) {
    const meta =
      /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)/i.exec(html)?.[1] ??
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time/i.exec(html)?.[1] ??
      blocks.map((block) => str(block.datePublished)).find(Boolean) ??
      /<time[^>]+datetime=["']([^"']+)/i.exec(html)?.[1] ??
      null;
    facts.posted = toIsoDate(meta);
  }

  if (!facts.deadline) facts.deadline = toIsoDate(DEADLINE_TEXT.exec(text)?.[1] ?? null);
  facts.closed = /\b(this (job|position|vacancy|opportunity|advert) (has )?(expired|closed)|applications? (are )?(now )?closed|no longer accepting applications|position (has been )?filled)\b/i.test(
    text,
  );
  facts.emails = [...new Set([...facts.emails, ...emailsIn(text)])].slice(0, 10);
  return facts;
}
