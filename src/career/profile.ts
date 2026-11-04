/**
 * A member's professional profile: what CVs and applications are built from.
 *
 * Everything here comes from the member — typed, or read from a CV they sent.
 * Nothing is ever invented to fill a gap; gaps become questions.
 */
import { z } from 'zod';

const text = z.string().trim().max(400);
const shortText = z.string().trim().max(160);

export const EducationSchema = z.object({
  institution: shortText,
  qualification: shortText,
  field: shortText.optional(),
  level: z.enum(['certificate', 'diploma', 'higher-diploma', 'bachelor', 'postgraduate-diploma', 'master', 'phd', 'other']).optional(),
  start: shortText.optional(),
  end: shortText.optional(),
  grade: shortText.optional(),
  notes: text.optional(),
});

export const ExperienceSchema = z.object({
  role: shortText,
  organization: shortText,
  kind: z.enum(['job', 'internship', 'attachment', 'volunteer', 'research', 'other']).optional(),
  location: shortText.optional(),
  start: shortText.optional(),
  end: shortText.optional(),
  current: z.boolean().optional(),
  highlights: z.array(text).max(10).default([]),
});

export const ProfileSchema = z.object({
  fullName: shortText.optional(),
  email: z.string().trim().email().max(160).optional(),
  phone: shortText.optional(),
  location: shortText.optional(),
  linkedin: shortText.optional(),
  headline: shortText.optional(),
  summary: z.string().trim().max(1200).optional(),
  education: z.array(EducationSchema).max(10).default([]),
  experience: z.array(ExperienceSchema).max(20).default([]),
  skills: z.array(shortText).max(40).default([]),
  certifications: z.array(z.object({ name: shortText, issuer: shortText.optional(), year: shortText.optional() })).max(20).default([]),
  projects: z.array(z.object({ name: shortText, description: text.optional(), link: shortText.optional() })).max(10).default([]),
  achievements: z.array(text).max(15).default([]),
  languages: z.array(shortText).max(10).default([]),
  /** What they want: roles, fields, opportunity kinds, places. */
  targetRoles: z.array(shortText).max(10).default([]),
  interests: z.array(shortText).max(15).default([]),
  preferredLocations: z.array(shortText).max(10).default([]),
  referees: z.array(z.object({ name: shortText, title: shortText.optional(), organization: shortText.optional(), contact: shortText.optional() })).max(5).default([]),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type ProfilePatch = Partial<Profile>;

export const EMPTY_PROFILE: Profile = ProfileSchema.parse({});

/** Years and similar arrive as numbers; the schema keeps them as text. */
function textify(value: unknown): unknown {
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textify);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item === null ? undefined : textify(item)]));
  return value;
}

/** Parse one value; on failure drop the offending properties (an odd "level", a bad email) and keep the rest. */
function salvage(schema: z.ZodTypeAny, value: unknown): unknown {
  let candidate = value;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
    const bad = new Set(parsed.error.issues.map((issue) => issue.path[0]).filter((key): key is string => typeof key === 'string'));
    if (bad.size === 0) return undefined;
    candidate = Object.fromEntries(Object.entries(candidate).filter(([key]) => !bad.has(key)));
  }
  return undefined;
}

/** Parse stored or AI-supplied data, dropping what does not fit rather than failing. */
export function cleanProfile(value: unknown): Profile {
  const input = textify(value ?? {});
  const parsed = ProfileSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  // Keep the valid parts: field by field, and list item by list item.
  const result: Record<string, unknown> = {};
  const fields = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  for (const [key, schema] of Object.entries(ProfileSchema.shape) as Array<[string, z.ZodTypeAny]>) {
    const raw = fields[key];
    if (raw === undefined) continue;
    const element = schema instanceof z.ZodDefault ? schema._def.innerType : schema;
    if (Array.isArray(raw) && element instanceof z.ZodArray) {
      const items = raw.map((item) => salvage(element.element as z.ZodTypeAny, item)).filter((item) => item !== undefined);
      const list = schema.safeParse(items);
      if (list.success) result[key] = list.data;
      continue;
    }
    const field = schema.safeParse(raw);
    if (field.success && field.data !== undefined) result[key] = field.data;
  }
  return ProfileSchema.parse(result);
}

/**
 * Merge new details into a profile. Lists are combined without duplicates;
 * a single value is replaced. `replace` lists (e.g. a corrected education
 * history) are taken as given.
 */
export function mergeProfile(current: Profile, patch: ProfilePatch, replace: Array<keyof Profile> = []): Profile {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch) as Array<[keyof Profile, unknown]>) {
    if (value === undefined || value === null) continue;
    const existing = current[key];
    if (Array.isArray(existing) && Array.isArray(value) && !replace.includes(key)) {
      // The same job, course or certificate told twice in different words is one entry, updated.
      const identity = (item: unknown): string => {
        const record = (item && typeof item === 'object' ? item : { value: item }) as Record<string, unknown>;
        const parts = 'role' in record ? [record.role, record.organization] : 'institution' in record ? [record.institution, record.qualification] : 'name' in record ? [record.name] : [record.value ?? JSON.stringify(record)];
        return parts.map((part) => String(part ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).join('|');
      };
      const merged: unknown[] = [...existing];
      for (const item of value) {
        const at = merged.findIndex((current) => identity(current) === identity(item));
        if (at === -1) merged.push(item);
        else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const before = merged[at] as Record<string, unknown>;
          const after = item as Record<string, unknown>;
          const highlights = Array.isArray(before.highlights) && Array.isArray(after.highlights)
            ? { highlights: [...new Set([...(before.highlights as string[]), ...(after.highlights as string[])])].slice(0, 10) }
            : {};
          merged[at] = { ...before, ...Object.fromEntries(Object.entries(after).filter(([, field]) => field !== undefined && field !== '')), ...highlights };
        }
      }
      next[key] = merged;
    } else {
      next[key] = value;
    }
  }
  return cleanProfile(next);
}

export interface Readiness {
  ready: boolean;
  /** Plain-language names of what is still needed for a CV. */
  missing: string[];
  /** Nice to have; asked about once, never required. */
  helpful: string[];
}

/** What a CV needs before it can be written without inventing anything. */
export function cvReadiness(profile: Profile): Readiness {
  const missing: string[] = [];
  if (!profile.fullName) missing.push('your full name');
  if (!profile.email && !profile.phone) missing.push('an email address or phone number for the CV');
  if (profile.education.length === 0) missing.push('your education (institution, course, level and years)');
  if (profile.experience.length === 0 && profile.skills.length < 3 && profile.projects.length === 0) {
    missing.push('your experience (jobs, internships, attachments or volunteering) or at least a few skills');
  }
  const helpful: string[] = [];
  if (profile.skills.length < 5) helpful.push('your key skills (technical and soft)');
  if (profile.certifications.length === 0) helpful.push('certifications or short courses');
  if (profile.targetRoles.length === 0) helpful.push('the kind of role you are aiming for');
  if (profile.referees.length === 0) helpful.push('two referees (name, title, organisation, contact)');
  return { ready: missing.length === 0, missing, helpful };
}

/** A compact, readable summary of the profile for WhatsApp. */
export function describeProfile(profile: Profile): string {
  const lines: string[] = [];
  if (profile.fullName) lines.push(`*${profile.fullName}*${profile.headline ? ` — ${profile.headline}` : ''}`);
  const contact = [profile.email, profile.phone, profile.location].filter(Boolean).join(' · ');
  if (contact) lines.push(contact);
  if (profile.education.length > 0) {
    lines.push('', '🎓 *Education*');
    for (const item of profile.education) lines.push(`• ${item.qualification}${item.field ? ` in ${item.field}` : ''}, ${item.institution}${item.end ? ` (${item.end})` : ''}`);
  }
  if (profile.experience.length > 0) {
    lines.push('', '💼 *Experience*');
    for (const item of profile.experience) lines.push(`• ${item.role}, ${item.organization}${item.start || item.end ? ` (${[item.start, item.current ? 'present' : item.end].filter(Boolean).join(' – ')})` : ''}`);
  }
  if (profile.skills.length > 0) lines.push('', `🛠️ *Skills:* ${profile.skills.join(', ')}`);
  if (profile.certifications.length > 0) lines.push(`📜 *Certifications:* ${profile.certifications.map((item) => item.name).join(', ')}`);
  if (profile.targetRoles.length > 0) lines.push(`🎯 *Aiming for:* ${profile.targetRoles.join(', ')}`);
  return lines.length > 0 ? lines.join('\n') : 'Your profile is empty so far.';
}

export const CONSENT_TEXT = [
  '🔒 *Before I save your details*',
  '',
  'To build CVs and prepare applications, I keep a profile with your name, contacts, education, experience and skills, plus the CVs and letters I make for you.',
  '',
  '• Only you can see it; it is used only to help you apply.',
  '• It is deleted after 12 months without use.',
  '• You can delete everything at any time: send *delete my data*.',
  '',
  'Reply *YES* to agree, or *NO* to continue without saving anything.',
].join('\n');

/** Did the member clearly agree? Deterministic, so consent never rests on a model's reading. */
export function isConsent(message: string): boolean {
  return /^\s*(yes|y|yeah|yep|i agree|agree|ok|okay|sawa|ndio|ndiyo|accept|i accept)\b[\s.!]*$/i.test(message);
}
