/**
 * How a tracked opportunity looks in WhatsApp: one card, always the same
 * layout, so members learn to read them at a glance. Also the Friday report,
 * its spreadsheet, and the weekend message.
 */
import { TYPE_LABELS, type OpportunityType } from '../domain/opportunity.js';

export interface OpportunityCard {
  title: string;
  organization: string | null;
  type: OpportunityType;
  /** The public-health field, e.g. "Community health", "Health records". */
  field: string | null;
  location: string | null;
  salary: string | null;
  /** ISO date (YYYY-MM-DD) when known. */
  deadline: string | null;
  /** Full-time, contract, internship length… */
  terms: string | null;
  /** Education or experience asked for, in a line. */
  requirements: string | null;
  /** Two or three sentences on what the role or opportunity is. */
  summary: string | null;
  /** The employer's own page when found; the listing page otherwise. */
  applyUrl: string;
  /** True when applyUrl is the employer's own page, not the listing site. */
  original: boolean;
  /** The site it was found on. */
  foundOn: string;
}

const TYPE_ICON: Partial<Record<OpportunityType, string>> = {
  JOB: '💼',
  INTERNSHIP: '🎓',
  SCHOLARSHIP: '🎓',
  FELLOWSHIP: '🌍',
  GRANT: '💰',
  VOLUNTEER: '🤝',
  TRAINING: '📚',
  CONFERENCE: '🎤',
  RESEARCH: '🔬',
};

export function formatDeadline(iso: string | null, now = new Date()): string | null {
  if (!iso) return null;
  const date = new Date(`${iso}T23:59:59+03:00`);
  if (Number.isNaN(date.getTime())) return null;
  const days = Math.ceil((date.getTime() - now.getTime()) / 86_400_000);
  const label = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Nairobi' });
  if (days < 0) return `${label} (closed)`;
  if (days === 0) return `${label} (closes today)`;
  if (days <= 7) return `${label} (${days} day${days === 1 ? '' : 's'} left)`;
  return label;
}

function line(icon: string, label: string, value: string | null): string | null {
  return value && value.trim().length > 0 ? `${icon} *${label}:* ${value.trim()}` : null;
}

/** One opportunity, as a WhatsApp message. */
export function renderCard(card: OpportunityCard, now = new Date()): string {
  const icon = TYPE_ICON[card.type] ?? '📌';
  const kind = [TYPE_LABELS[card.type], card.field].filter(Boolean).join(' · ');
  const lines = [
    `${icon} *${card.title.trim()}*`,
    kind ? `_${kind}_` : null,
    '',
    line('🏢', 'Organisation', card.organization),
    line('📍', 'Location', card.location),
    line('💵', 'Salary', card.salary ?? 'Not stated'),
    line('🗂️', 'Terms', card.terms),
    line('🗓️', 'Deadline', formatDeadline(card.deadline, now) ?? 'Not stated'),
    line('🎯', 'Requirements', card.requirements),
    card.summary ? `\n${card.summary.trim()}` : null,
    '',
    `🔗 *${card.original ? 'Apply' : 'Details'}:* ${card.applyUrl}`,
    `_Found on ${card.foundOn} · Public Health Colosseum_`,
  ];
  return lines
    .filter((entry): entry is string => entry !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

const REPORT_ORDER: OpportunityType[] = ['JOB', 'INTERNSHIP', 'FELLOWSHIP', 'SCHOLARSHIP', 'GRANT', 'VOLUNTEER', 'TRAINING', 'CONFERENCE'];

/**
 * The Friday report: everything found this week, grouped by type, split into
 * messages small enough for WhatsApp.
 */
export function renderWeeklyReport(
  cards: OpportunityCard[],
  weekLabel: string,
  now = new Date(),
  heading = '📊 *Weekly public-health opportunities report*',
): string[] {
  if (cards.length === 0) {
    return [`${heading}\n_${weekLabel}_\n\nNo public-health opportunities to show.`];
  }
  const groups = new Map<OpportunityType, OpportunityCard[]>();
  for (const card of cards) groups.set(card.type, [...(groups.get(card.type) ?? []), card]);
  const order = [...REPORT_ORDER, ...[...groups.keys()].filter((type) => !REPORT_ORDER.includes(type))];

  const summary = order
    .filter((type) => groups.has(type))
    .map((type) => `• ${TYPE_LABELS[type]}: *${groups.get(type)?.length ?? 0}*`)
    .join('\n');

  const header = [
    heading,
    `_${weekLabel}_`,
    '',
    `*${cards.length}* opportunities:`,
    summary,
    '',
    'The full table is attached as a spreadsheet.',
  ].join('\n');

  const sections: string[] = [];
  for (const type of order) {
    const items = groups.get(type);
    if (!items) continue;
    const rows = items.map((card, index) => {
      const facts = [card.organization, card.location, card.salary, formatDeadline(card.deadline, now)]
        .filter(Boolean)
        .join(' · ');
      return `${index + 1}. *${card.title}*${facts ? `\n   ${facts}` : ''}\n   ${card.applyUrl}`;
    });
    sections.push(`*${TYPE_LABELS[type]} (${items.length})*\n\n${rows.join('\n\n')}`);
  }

  // WhatsApp copes with long messages, but phones do not: about 3,500
  // characters per message reads comfortably.
  const messages = [header];
  let current = '';
  for (const section of sections) {
    for (const chunk of section.split('\n\n')) {
      if (current.length + chunk.length > 3500 && current.length > 0) {
        messages.push(current.trim());
        current = '';
      }
      current += `${chunk}\n\n`;
    }
  }
  if (current.trim()) messages.push(current.trim());
  return messages;
}

function csvCell(value: string | null): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The report as a spreadsheet: opens as a table in Excel, Sheets or a phone. */
export function weeklyReportCsv(cards: OpportunityCard[]): string {
  const header = ['Type', 'Position', 'Organisation', 'Field', 'Location', 'Salary', 'Deadline', 'Terms', 'Requirements', 'Link', 'Found on'];
  const rows = cards.map((card) =>
    [
      TYPE_LABELS[card.type],
      card.title,
      card.organization,
      card.field,
      card.location,
      card.salary,
      card.deadline,
      card.terms,
      card.requirements,
      card.applyUrl,
      card.foundOn,
    ]
      .map((value) => csvCell(value))
      .join(','),
  );
  // The byte-order mark makes Excel read the file as UTF-8.
  return `﻿${[header.join(','), ...rows].join('\r\n')}\r\n`;
}

export function weekendMessage(): string {
  return [
    '🌅 *That’s a wrap for this week!*',
    '',
    'Thank you for being part of the Public Health Colosseum. Take the weekend to rest, recharge and maybe polish that CV or personal statement. 📝',
    '',
    'Opportunity updates pause for the weekend and return on *Monday morning*.',
    '',
    'Have a restful weekend! 💚',
    '_Public Health Colosseum · powered by SCIAT SOLUTIONS_',
  ].join('\n');
}
