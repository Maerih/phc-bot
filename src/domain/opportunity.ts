/**
 * The Opportunity domain model.
 *
 * Deliberately generalised: a job, a scholarship, a fellowship, a call for
 * papers and a conference are all Opportunities that differ by `type`, not by
 * table. Everything downstream — search, ranking, matching, digests, the admin
 * dashboard — reads this one shape.
 *
 * Honesty rule, applied throughout: a field we do not know is `null`. We never
 * substitute a plausible value, and the WhatsApp/HTTP renderers say "not
 * stated" rather than guessing. A wrong deadline on a scholarship costs a
 * member a real chance, so unknown has to stay unknown.
 */

export const OPPORTUNITY_TYPES = [
  'JOB',
  'INTERNSHIP',
  'SCHOLARSHIP',
  'FELLOWSHIP',
  'RESEARCH',
  'GRANT',
  'CONFERENCE',
  'TRAINING',
  'HACKATHON',
  'VOLUNTEER',
  'PROJECT',
  'MENTORSHIP',
  'EVENT',
  'PROGRAM',
] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

/**
 * Lifecycle. Nothing reaches members before PUBLISHED.
 *
 *   DISCOVERED ─> PENDING_REVIEW ─> VERIFIED ─> PUBLISHED ─> EXPIRED
 *                      └────────────> REJECTED
 */
export const OPPORTUNITY_STATUSES = [
  'DISCOVERED',
  'PENDING_REVIEW',
  'VERIFIED',
  'PUBLISHED',
  'EXPIRED',
  'REJECTED',
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/**
 * How a record came to be trusted. `AI_ASSISTED` means a model helped
 * structure or sanity-check the record — it is NOT a claim that the
 * opportunity is genuine, and the renderers never present it as one.
 */
export const VERIFICATION_STATUSES = [
  'UNVERIFIED',
  'SOURCE_VERIFIED',
  'AI_ASSISTED',
  'ADMIN_VERIFIED',
  'EXPIRED',
  'FLAGGED',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const EXPERIENCE_LEVELS = ['UNKNOWN', 'ENTRY', 'GRADUATE', 'MID', 'SENIOR', 'EXECUTIVE'] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

export const EDUCATION_LEVELS = [
  'UNKNOWN',
  'SECONDARY',
  'CERTIFICATE',
  'DIPLOMA',
  'BACHELORS',
  'MASTERS',
  'DOCTORATE',
] as const;
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];

/**
 * Subject categories relevant to the Colosseum. Kept as a flat list rather
 * than a DB enum so administrators can extend it without a migration.
 */
export const CATEGORIES = [
  'PUBLIC_HEALTH',
  'EPIDEMIOLOGY',
  'GLOBAL_HEALTH',
  'HEALTH_INFORMATICS',
  'DIGITAL_HEALTH',
  'HEALTH_POLICY',
  'MONITORING_EVALUATION',
  'BIOSTATISTICS',
  'DATA_SCIENCE',
  'ENVIRONMENTAL_HEALTH',
  'MENTAL_HEALTH',
  'NUTRITION',
  'MATERNAL_CHILD_HEALTH',
  'INFECTIOUS_DISEASE',
  'HEALTH_ECONOMICS',
  'RESEARCH',
  'CYBERSECURITY',
  'SOFTWARE',
  'AI',
  'OTHER',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** A fully normalised opportunity as it is stored and served. */
export interface Opportunity {
  id: string;

  title: string;
  organization: string | null;
  description: string | null;

  type: OpportunityType;
  categories: Category[];

  /** Free-text location exactly as the source stated it. */
  location: string | null;
  /** ISO-3166 alpha-2, uppercase, when confidently resolved. */
  country: string | null;
  /** null = the source did not say. Not the same as `false`. */
  remote: boolean | null;

  eligibility: string | null;
  educationLevel: EducationLevel;
  experienceLevel: ExperienceLevel;

  /** Application closing date. null when the source states none. */
  deadline: Date | null;
  applicationUrl: string | null;

  sourceUrl: string | null;
  sourceName: string;
  sourceSlug: string;
  datePosted: Date | null;

  status: OpportunityStatus;
  verificationStatus: VerificationStatus;
  verifiedAt: Date | null;

  tags: string[];
  skills: string[];
  /** Verbatim compensation text. Never normalised into a number we invented. */
  compensation: string | null;

  /** Stable content hash used for cross-source de-duplication. */
  fingerprint: string;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * What a source connector produces. Narrower than `Opportunity`: the
 * normalisation layer fills in ids, fingerprints, status and timestamps, so a
 * connector only has to report what its upstream actually said.
 */
export interface RawOpportunity {
  title: string;
  organization?: string | null;
  description?: string | null;
  type?: OpportunityType;
  location?: string | null;
  country?: string | null;
  remote?: boolean | null;
  eligibility?: string | null;
  deadline?: Date | null;
  applicationUrl?: string | null;
  sourceUrl?: string | null;
  datePosted?: Date | null;
  tags?: string[];
  skills?: string[];
  compensation?: string | null;
  /** Upstream's own identifier, when it has a stable one. */
  externalId?: string | null;
}

/** Human-readable labels for WhatsApp and dashboard output. */
export const TYPE_LABELS: Record<OpportunityType, string> = {
  JOB: 'Job',
  INTERNSHIP: 'Internship',
  SCHOLARSHIP: 'Scholarship',
  FELLOWSHIP: 'Fellowship',
  RESEARCH: 'Research',
  GRANT: 'Grant',
  CONFERENCE: 'Conference',
  TRAINING: 'Training',
  HACKATHON: 'Hackathon',
  VOLUNTEER: 'Volunteer',
  PROJECT: 'Project',
  MENTORSHIP: 'Mentorship',
  EVENT: 'Event',
  PROGRAM: 'Programme',
};

export const CATEGORY_LABELS: Record<Category, string> = {
  PUBLIC_HEALTH: 'Public Health',
  EPIDEMIOLOGY: 'Epidemiology',
  GLOBAL_HEALTH: 'Global Health',
  HEALTH_INFORMATICS: 'Health Informatics',
  DIGITAL_HEALTH: 'Digital Health',
  HEALTH_POLICY: 'Health Policy',
  MONITORING_EVALUATION: 'Monitoring & Evaluation',
  BIOSTATISTICS: 'Biostatistics',
  DATA_SCIENCE: 'Data Science',
  ENVIRONMENTAL_HEALTH: 'Environmental Health',
  MENTAL_HEALTH: 'Mental Health',
  NUTRITION: 'Nutrition',
  MATERNAL_CHILD_HEALTH: 'Maternal & Child Health',
  INFECTIOUS_DISEASE: 'Infectious Disease',
  HEALTH_ECONOMICS: 'Health Economics',
  RESEARCH: 'Research',
  CYBERSECURITY: 'Cybersecurity',
  SOFTWARE: 'Software',
  AI: 'Artificial Intelligence',
  OTHER: 'Other',
};

/** An opportunity is stale once its stated deadline has passed. */
export function isExpired(opportunity: Pick<Opportunity, 'deadline'>, now = new Date()): boolean {
  if (!opportunity.deadline) return false; // unknown deadline is not evidence of expiry
  return opportunity.deadline.getTime() < now.getTime();
}

/** Whole days until the deadline; null when no deadline is known. */
export function daysUntilDeadline(opportunity: Pick<Opportunity, 'deadline'>, now = new Date()): number | null {
  if (!opportunity.deadline) return null;
  const msPerDay = 86_400_000;
  return Math.ceil((opportunity.deadline.getTime() - now.getTime()) / msPerDay);
}
