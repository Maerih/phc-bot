/**
 * Storage for the career assistant. Every function takes the member's id and
 * filters by it: there is no way to read another member's profile, documents
 * or applications through this module.
 */
import { connection as sql } from '../db/client.js';
import { cleanProfile, EMPTY_PROFILE, type Profile } from './profile.js';

// ── Profiles ────────────────────────────────────────────────────────────────

export interface ProfileRecord {
  profile: Profile;
  consentAt: Date | null;
}

export async function getProfile(memberId: string): Promise<ProfileRecord> {
  const [row] = await sql<{ profile: unknown; consent_at: Date | null }[]>`
    select profile, consent_at from member_profiles where member_id = ${memberId}`;
  await sql`update member_profiles set last_active_at = now() where member_id = ${memberId}`;
  return { profile: row ? cleanProfile(row.profile) : EMPTY_PROFILE, consentAt: row?.consent_at ?? null };
}

export async function recordConsent(memberId: string): Promise<void> {
  await sql`
    insert into member_profiles (member_id, consent_at) values (${memberId}, now())
    on conflict (member_id) do update set consent_at = coalesce(member_profiles.consent_at, now()), last_active_at = now()`;
}

export async function saveProfile(memberId: string, profile: Profile): Promise<void> {
  await sql`
    update member_profiles set profile = ${JSON.stringify(profile)}::jsonb, updated_at = now(), last_active_at = now()
    where member_id = ${memberId} and consent_at is not null`;
}

// ── Documents ───────────────────────────────────────────────────────────────

export interface DocumentRecord {
  id: string;
  kind: 'cv' | 'cover_letter' | 'upload' | 'screenshot';
  title: string;
  fileName: string;
  mime: string;
  createdAt: Date;
  meta: Record<string, unknown>;
}

export async function saveDocument(
  memberId: string,
  doc: { kind: DocumentRecord['kind']; title: string; fileName: string; mime: string; bytes: Buffer; meta?: Record<string, unknown> },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into member_documents (member_id, kind, title, file_name, mime, bytes, meta)
    values (${memberId}, ${doc.kind}, ${doc.title}, ${doc.fileName}, ${doc.mime}, ${doc.bytes}, ${JSON.stringify(doc.meta ?? {})}::jsonb)
    returning id`;
  return row!.id;
}

export async function listDocuments(memberId: string, kind?: DocumentRecord['kind']): Promise<DocumentRecord[]> {
  const rows = await sql<{ id: string; kind: DocumentRecord['kind']; title: string; file_name: string; mime: string; created_at: Date; meta: Record<string, unknown> }[]>`
    select id, kind, title, file_name, mime, created_at, meta from member_documents
    where member_id = ${memberId} ${kind ? sql`and kind = ${kind}` : sql``}
    order by created_at desc limit 50`;
  return rows.map((row) => ({ id: row.id, kind: row.kind, title: row.title, fileName: row.file_name, mime: row.mime, createdAt: row.created_at, meta: row.meta }));
}

export async function readDocument(memberId: string, id: string): Promise<(DocumentRecord & { bytes: Buffer }) | null> {
  const [row] = await sql<{ id: string; kind: DocumentRecord['kind']; title: string; file_name: string; mime: string; created_at: Date; meta: Record<string, unknown>; bytes: Buffer }[]>`
    select id, kind, title, file_name, mime, created_at, meta, bytes from member_documents
    where member_id = ${memberId} and id = ${id}`;
  return row ? { id: row.id, kind: row.kind, title: row.title, fileName: row.file_name, mime: row.mime, createdAt: row.created_at, meta: row.meta, bytes: Buffer.from(row.bytes) } : null;
}

// ── Applications ────────────────────────────────────────────────────────────

export type ApplicationStatus =
  | 'preparing'
  | 'needs_info'
  | 'ready_to_send'
  | 'awaiting_approval'
  | 'submitted'
  | 'cancelled'
  | 'failed';

export interface OpportunityRef {
  title: string;
  organization: string | null;
  url: string;
  listingUrl?: string | null;
  deadline: string | null;
  location: string | null;
  summary?: string | null;
  source?: string | null;
}

export interface ChannelDetail {
  method?: 'email' | 'portal' | 'both' | 'unknown';
  email?: string | null;
  portalUrl?: string | null;
  subjectFormat?: string | null;
  instructions?: string | null;
  requiredDocuments?: string[];
  deadline?: string | null;
  contact?: string | null;
  /** Where the channel was confirmed: the employer's own site, or only a job board. */
  verifiedOn?: string | null;
  verified?: boolean;
  /** Simple form the bot may fill (no login, no CAPTCHA). */
  autofill?: boolean;
}

export interface ApplicationRecord {
  id: string;
  number: number;
  opportunityKey: string;
  opportunity: OpportunityRef;
  channel: string;
  channelDetail: ChannelDetail;
  suitability: { score?: number; strengths?: string[]; gaps?: string[]; verdict?: string };
  emailSubject: string | null;
  emailBody: string | null;
  coverLetter: string | null;
  cvDocumentId: string | null;
  letterDocumentId: string | null;
  status: ApplicationStatus;
  statusNote: string | null;
  reference: string | null;
  submittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type ApplicationRow = {
  id: string; number: number; opportunity_key: string; opportunity: OpportunityRef; channel: string; channel_detail: ChannelDetail;
  suitability: ApplicationRecord['suitability']; email_subject: string | null; email_body: string | null; cover_letter: string | null;
  cv_document_id: string | null; letter_document_id: string | null; status: ApplicationStatus; status_note: string | null;
  reference: string | null; submitted_at: Date | null; created_at: Date; updated_at: Date;
};

function toApplication(row: ApplicationRow): ApplicationRecord {
  return {
    id: row.id, number: row.number, opportunityKey: row.opportunity_key, opportunity: row.opportunity, channel: row.channel,
    channelDetail: row.channel_detail ?? {}, suitability: row.suitability ?? {}, emailSubject: row.email_subject, emailBody: row.email_body,
    coverLetter: row.cover_letter, cvDocumentId: row.cv_document_id, letterDocumentId: row.letter_document_id, status: row.status,
    statusNote: row.status_note, reference: row.reference, submittedAt: row.submitted_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/**
 * Start an application, or return the one already started for this
 * opportunity: the unique key makes a second, accidental one impossible.
 */
export async function createApplication(memberId: string, key: string, opportunity: OpportunityRef): Promise<{ application: ApplicationRecord; existed: boolean }> {
  const [existing] = await sql<ApplicationRow[]>`select * from applications where member_id = ${memberId} and opportunity_key = ${key}`;
  if (existing) return { application: toApplication(existing), existed: true };
  const [row] = await sql<ApplicationRow[]>`
    insert into applications (member_id, number, opportunity_key, opportunity)
    values (${memberId}, (select coalesce(max(number), 0) + 1 from applications where member_id = ${memberId}), ${key}, ${JSON.stringify(opportunity)}::jsonb)
    on conflict (member_id, opportunity_key) do nothing
    returning *`;
  if (row) return { application: toApplication(row), existed: false };
  const [raced] = await sql<ApplicationRow[]>`select * from applications where member_id = ${memberId} and opportunity_key = ${key}`;
  return { application: toApplication(raced!), existed: true };
}

export async function updateApplication(
  memberId: string,
  id: string,
  patch: Partial<{
    channel: string; channelDetail: ChannelDetail; suitability: ApplicationRecord['suitability']; emailSubject: string | null;
    emailBody: string | null; coverLetter: string | null; cvDocumentId: string | null; letterDocumentId: string | null;
    status: ApplicationStatus; statusNote: string | null; reference: string | null; submittedAt: Date | null;
  }>,
): Promise<void> {
  const columns: Record<string, unknown> = {};
  if (patch.channel !== undefined) columns.channel = patch.channel;
  if (patch.channelDetail !== undefined) columns.channel_detail = JSON.stringify(patch.channelDetail);
  if (patch.suitability !== undefined) columns.suitability = JSON.stringify(patch.suitability);
  if (patch.emailSubject !== undefined) columns.email_subject = patch.emailSubject;
  if (patch.emailBody !== undefined) columns.email_body = patch.emailBody;
  if (patch.coverLetter !== undefined) columns.cover_letter = patch.coverLetter;
  if (patch.cvDocumentId !== undefined) columns.cv_document_id = patch.cvDocumentId;
  if (patch.letterDocumentId !== undefined) columns.letter_document_id = patch.letterDocumentId;
  if (patch.status !== undefined) columns.status = patch.status;
  if (patch.statusNote !== undefined) columns.status_note = patch.statusNote;
  if (patch.reference !== undefined) columns.reference = patch.reference;
  if (patch.submittedAt !== undefined) columns.submitted_at = patch.submittedAt;
  if (Object.keys(columns).length === 0) return;
  const jsonColumns = new Set(['channel_detail', 'suitability']);
  for (const [column, value] of Object.entries(columns)) {
    if (jsonColumns.has(column)) {
      await sql`update applications set ${sql(column)} = ${value as string}::jsonb, updated_at = now() where member_id = ${memberId} and id = ${id}`;
    } else {
      await sql`update applications set ${sql(column)} = ${value as string | null}, updated_at = now() where member_id = ${memberId} and id = ${id}`;
    }
  }
}

export async function getApplication(memberId: string, number: number): Promise<ApplicationRecord | null> {
  const [row] = await sql<ApplicationRow[]>`select * from applications where member_id = ${memberId} and number = ${number}`;
  return row ? toApplication(row) : null;
}

export async function listApplications(memberId: string, status?: ApplicationStatus[]): Promise<ApplicationRecord[]> {
  const rows = await sql<ApplicationRow[]>`
    select * from applications where member_id = ${memberId}
    ${status && status.length > 0 ? sql`and status in ${sql(status)}` : sql``}
    order by number desc limit 50`;
  return rows.map(toApplication);
}

// ── Conversation memory ─────────────────────────────────────────────────────

export interface ThreadMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Thread {
  messages: ThreadMessage[];
  /** Short-lived state: last search results, a confirmation awaited. */
  pending: Record<string, unknown> | null;
  updatedAt: Date | null;
}

export async function getThread(memberId: string): Promise<Thread> {
  const [row] = await sql<{ messages: ThreadMessage[]; pending: Record<string, unknown> | null; updated_at: Date }[]>`
    select messages, pending, updated_at from assistant_threads where member_id = ${memberId}`;
  if (!row) return { messages: [], pending: null, updatedAt: null };
  // A conversation idle for six hours starts fresh.
  if (Date.now() - new Date(row.updated_at).getTime() > 6 * 3_600_000) return { messages: [], pending: row.pending, updatedAt: row.updated_at };
  return { messages: row.messages ?? [], pending: row.pending, updatedAt: row.updated_at };
}

export async function saveThread(memberId: string, messages: ThreadMessage[], pending: Record<string, unknown> | null): Promise<void> {
  const kept = messages.slice(-16);
  await sql`
    insert into assistant_threads (member_id, messages, pending, updated_at)
    values (${memberId}, ${JSON.stringify(kept)}::jsonb, ${pending ? JSON.stringify(pending) : null}::jsonb, now())
    on conflict (member_id) do update set messages = excluded.messages, pending = excluded.pending, updated_at = now()`;
}

// ── Privacy ─────────────────────────────────────────────────────────────────

/** Delete everything the career assistant holds about a member. */
export async function deleteMemberData(memberId: string): Promise<{ documents: number; applications: number }> {
  const apps = await sql`delete from applications where member_id = ${memberId} returning id`;
  const docs = await sql`delete from member_documents where member_id = ${memberId} returning id`;
  await sql`delete from assistant_threads where member_id = ${memberId}`;
  await sql`delete from member_profiles where member_id = ${memberId}`;
  return { documents: docs.length, applications: apps.length };
}

/** Retention: members inactive for 12 months lose their stored career data. */
export async function purgeInactive(): Promise<number> {
  const rows = await sql<{ member_id: string }[]>`
    select member_id from member_profiles where last_active_at < now() - interval '12 months'`;
  for (const row of rows) await deleteMemberData(row.member_id);
  return rows.length;
}

// ── Settings ────────────────────────────────────────────────────────────────

export async function getSetting(key: string): Promise<string | null> {
  const [row] = await sql<{ value: string }[]>`select value from bot_settings where key = ${key}`;
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await sql`insert into bot_settings (key, value) values (${key}, ${value}) on conflict (key) do update set value = excluded.value, updated_at = now()`;
}
