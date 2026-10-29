/**
 * Rule-based classification.
 *
 * This runs on every opportunity, with or without an AI provider configured —
 * it is the platform's graceful-degradation floor. When Phase 3 adds the AI
 * layer, the model refines these results; it does not replace them, so search
 * keeps working if the provider is down, unbilled or misconfigured.
 *
 * Every function here returns an explicit "unknown" rather than a guess.
 */
import { canonical } from '../core/text.js';
import type { Category, EducationLevel, ExperienceLevel, OpportunityType } from './opportunity.js';

/**
 * Type detection, highest-priority signal first. The order matters: an
 * "Internship in Epidemiology Research" is an INTERNSHIP, not RESEARCH,
 * because the funding instrument is what the member applies through.
 */
const TYPE_RULES: Array<{ type: OpportunityType; patterns: RegExp[] }> = [
  { type: 'SCHOLARSHIP', patterns: [/\bscholarships?\b/, /\bbursar(y|ies)\b/, /\btuition (award|waiver)\b/] },
  { type: 'FELLOWSHIP', patterns: [/\bfellowships?\b/, /\bfellows? programme?\b/] },
  { type: 'INTERNSHIP', patterns: [/\binternships?\b/, /\binterne?\b/, /\battachment\b/, /\bindustrial attach/] },
  { type: 'GRANT', patterns: [/\bgrants?\b/, /\bseed funding\b/, /\bcall for proposals?\b/, /\bfunding opportunit/] },
  { type: 'HACKATHON', patterns: [/\bhackathons?\b/, /\bdatathons?\b/, /\bcode challenge\b/, /\bdesign sprint\b/] },
  { type: 'CONFERENCE', patterns: [/\bconferences?\b/, /\bsymposi(um|a)\b/, /\bcongress\b/, /\bcall for abstracts?\b/, /\bcall for papers?\b/] },
  { type: 'TRAINING', patterns: [/\btrainings?\b/, /\bshort courses?\b/, /\bworkshops?\b/, /\bcertificate course\b/, /\bbootcamps?\b/, /\bmooc\b/] },
  { type: 'MENTORSHIP', patterns: [/\bmentorships?\b/, /\bmentoring programme?\b/] },
  { type: 'VOLUNTEER', patterns: [/\bvolunteers?\b/, /\bvolunteering\b/, /\bpro bono\b/] },
  { type: 'RESEARCH', patterns: [/\bphd\b/, /\bdoctoral\b/, /\bpost-?doc/, /\bresearch (assistant|associate|fellow|officer|position|opportunit)/, /\bmsc by research\b/] },
  { type: 'PROGRAM', patterns: [/\bprogramme? for\b/, /\baccelerators?\b/, /\bincubators?\b/, /\bgraduate programme?\b/, /\btrainee programme?\b/] },
  { type: 'EVENT', patterns: [/\bwebinars?\b/, /\bsummits?\b/, /\bmeetups?\b/, /\bseminars?\b/] },
];

/**
 * Infer the opportunity type from free text.
 * Falls back to JOB, which is the correct default for a job-board connector
 * and the most common case overall.
 */
export function classifyType(...parts: Array<string | null | undefined>): OpportunityType {
  const haystack = ` ${canonical(parts.filter(Boolean).join(' '))} `;
  for (const rule of TYPE_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(haystack))) return rule.type;
  }
  return 'JOB';
}

const CATEGORY_RULES: Array<{ category: Category; patterns: RegExp[] }> = [
  { category: 'EPIDEMIOLOGY', patterns: [/\bepidemiolog/, /\bdisease surveillance\b/, /\boutbreak (response|investigation)\b/, /\bfield epidemiolog/] },
  { category: 'GLOBAL_HEALTH', patterns: [/\bglobal health\b/, /\binternational health\b/, /\bhumanitarian health\b/, /\btropical (medicine|health)\b/] },
  { category: 'HEALTH_INFORMATICS', patterns: [/\bhealth informatics\b/, /\bhealth informat/, /\bdhis2\b/, /\behr\b/, /\bhealth information system/, /\bemr\b/] },
  { category: 'DIGITAL_HEALTH', patterns: [/\bdigital health\b/, /\bmhealth\b/, /\btelemedicine\b/, /\btelehealth\b/, /\behealth\b/] },
  { category: 'HEALTH_POLICY', patterns: [/\bhealth polic/, /\bhealth systems? strengthening\b/, /\bhealth governance\b/, /\bhealth financing\b/] },
  { category: 'MONITORING_EVALUATION', patterns: [/\bmonitoring and evaluation\b/, /\bmonitoring evaluation\b/, /\bm ?and ?e\b/, /\bmeal\b/, /\bmerl\b/] },
  { category: 'BIOSTATISTICS', patterns: [/\bbiostatistic/, /\bbiometric/, /\bstatistician\b/] },
  { category: 'DATA_SCIENCE', patterns: [/\bdata scien/, /\bdata analyst\b/, /\bdata analytics\b/, /\bdata engineer/, /\bmachine learning\b/] },
  { category: 'ENVIRONMENTAL_HEALTH', patterns: [/\benvironmental health\b/, /\bwater sanitation\b/, /\bwash\b/, /\boccupational health\b/, /\bclimate and health\b/, /\bone health\b/] },
  { category: 'MENTAL_HEALTH', patterns: [/\bmental health\b/, /\bpsychosocial\b/, /\bpsychiatr/, /\bsubstance (use|abuse)\b/] },
  { category: 'NUTRITION', patterns: [/\bnutrition/, /\bfood security\b/, /\bdietetic/, /\bstunting\b/] },
  { category: 'MATERNAL_CHILD_HEALTH', patterns: [/\bmaternal\b/, /\bchild health\b/, /\breproductive health\b/, /\bmnch\b/, /\bsrhr?\b/, /\bmidwif/] },
  { category: 'INFECTIOUS_DISEASE', patterns: [/\binfectious disease/, /\bhiv\b/, /\btuberculosis\b/, /\b(tb|malaria)\b/, /\bimmuni[sz]ation\b/, /\bvaccin/, /\bamr\b/] },
  { category: 'HEALTH_ECONOMICS', patterns: [/\bhealth economic/, /\bcost-?effectiveness\b/, /\bhealth insurance\b/] },
  { category: 'CYBERSECURITY', patterns: [/\bcyber ?security\b/, /\binformation security\b/, /\bpenetration test/, /\bsoc analyst\b/, /\bappsec\b/] },
  { category: 'SOFTWARE', patterns: [/\bsoftware (engineer|developer)\b/, /\bfull-?stack\b/, /\bback-?end\b/, /\bfront-?end\b/, /\bdevops\b/] },
  { category: 'AI', patterns: [/\bartificial intelligence\b/, /\bdeep learning\b/, /\bnlp\b/, /\bllm\b/, /\bgenerative ai\b/] },
  { category: 'RESEARCH', patterns: [/\bresearch\b/, /\bclinical trial/, /\bprincipal investigator\b/, /\bprotocol development\b/] },
  { category: 'PUBLIC_HEALTH', patterns: [/\bpublic health\b/, /\bcommunity health\b/, /\bhealth promotion\b/, /\bmph\b/, /\bprimary health care\b/, /\bhealth education\b/] },
];

/** Occurrences of a pattern in a string. */
function countMatches(pattern: RegExp, haystack: string): number {
  const global = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
  return (haystack.match(global) ?? []).length;
}

/**
 * Assign every matching subject category.
 *
 * Multi-label on purpose: a "Health Informatics Data Analyst (M&E)" post is
 * genuinely all three, and members subscribe per category.
 *
 * `strongParts` (title, tags) is authoritative — one match is enough.
 * `weakText` (the body) needs two matches, because almost every job
 * description mentions health somewhere. A single "mental health support" in a
 * benefits list was enough to file a category-management role under Mental
 * Health, which is how members end up not trusting the categories at all.
 */
export function classifyCategories(
  strongParts: Array<string | null | undefined>,
  weakText?: string | null,
): Category[] {
  const strong = ` ${canonical(strongParts.filter(Boolean).join(' '))} `;
  const weak = weakText ? ` ${canonical(weakText)} ` : '';

  const matched = CATEGORY_RULES.filter((rule) =>
    rule.patterns.some(
      (pattern) => pattern.test(strong) || (weak.length > 0 && countMatches(pattern, weak) >= 2),
    ),
  ).map((rule) => rule.category);

  return matched.length > 0 ? Array.from(new Set(matched)) : ['OTHER'];
}

/** Seniority, inferred only from explicit wording. */
export function classifyExperienceLevel(...parts: Array<string | null | undefined>): ExperienceLevel {
  const haystack = ` ${canonical(parts.filter(Boolean).join(' '))} `;
  if (/\b(chief|director|head of|executive director|country director)\b/.test(haystack)) return 'EXECUTIVE';
  if (/\b(senior|snr|lead|principal|specialist iii)\b/.test(haystack)) return 'SENIOR';
  if (/\b(graduate (programme|trainee|scheme)|management trainee|fresh graduate)\b/.test(haystack)) return 'GRADUATE';
  if (/\b(entry.level|junior|jnr|assistant|intern|trainee|no experience)\b/.test(haystack)) return 'ENTRY';
  // Deliberately narrow. "Officer" and "Associate" were here and produced
  // nonsense: in NGO and government titles they span every seniority, so
  // "Health Officer" was reported as mid-level on no evidence at all.
  if (/\b(mid.level|mid career|experienced professional)\b/.test(haystack)) return 'MID';
  return 'UNKNOWN';
}

/** Minimum qualification, inferred only from explicit wording. */
export function classifyEducationLevel(...parts: Array<string | null | undefined>): EducationLevel {
  const haystack = ` ${canonical(parts.filter(Boolean).join(' '))} `;
  if (/\b(phd|doctorate|doctoral)\b/.test(haystack)) return 'DOCTORATE';
  if (/\b(masters?|msc|mph|mba|ma degree|postgraduate degree)\b/.test(haystack)) return 'MASTERS';
  if (/\b(bachelors?|bsc|undergraduate degree|degree in)\b/.test(haystack)) return 'BACHELORS';
  if (/\bdiplomas?\b/.test(haystack)) return 'DIPLOMA';
  if (/\bcertificates?\b/.test(haystack)) return 'CERTIFICATE';
  if (/\b(secondary|high school|kcse|o.level)\b/.test(haystack)) return 'SECONDARY';
  return 'UNKNOWN';
}

/**
 * Country resolution, weighted towards the Colosseum's membership (East and
 * wider Africa) plus the global-health employer hubs. Adjectival forms are
 * included because sources write "Kenyan nationals only" as often as "Kenya".
 *
 * Returns ISO-3166 alpha-2, or null when no single country is clear — a
 * multi-country listing must not be pinned to one place.
 */
const COUNTRY_PATTERNS: Array<[string, RegExp]> = [
  ['KE', /\b(kenya|kenyan|nairobi|mombasa|kisumu|nakuru|eldoret)\b/],
  ['UG', /\b(uganda|ugandan|kampala|entebbe|gulu)\b/],
  ['TZ', /\b(tanzania|tanzanian|dar es salaam|dodoma|arusha|zanzibar)\b/],
  ['RW', /\b(rwanda|rwandan|kigali)\b/],
  ['ET', /\b(ethiopia|ethiopian|addis ababa)\b/],
  ['NG', /\b(nigeria|nigerian|lagos|abuja|ibadan|kano)\b/],
  ['GH', /\b(ghana|ghanaian|accra|kumasi)\b/],
  ['ZA', /\b(south africa|south african|johannesburg|cape town|pretoria|durban)\b/],
  ['SS', /\b(south sudan|juba)\b/],
  ['SO', /\b(somalia|somali|mogadishu|hargeisa)\b/],
  ['SD', /\b(sudan|khartoum)\b/],
  ['ZM', /\b(zambia|zambian|lusaka)\b/],
  ['ZW', /\b(zimbabwe|zimbabwean|harare)\b/],
  ['MW', /\b(malawi|malawian|lilongwe|blantyre)\b/],
  ['MZ', /\b(mozambique|maputo)\b/],
  ['BW', /\b(botswana|gaborone)\b/],
  ['NA', /\b(namibia|windhoek)\b/],
  ['CD', /\b(democratic republic of (the )?congo|drc|kinshasa|goma)\b/],
  ['CM', /\b(cameroon|yaounde|douala)\b/],
  ['SN', /\b(senegal|dakar)\b/],
  ['CI', /\b(cote d ?ivoire|ivory coast|abidjan)\b/],
  ['EG', /\b(egypt|cairo)\b/],
  ['MA', /\b(morocco|rabat|casablanca)\b/],
  ['CH', /\b(switzerland|geneva|swiss|zurich)\b/],
  ['GB', /\b(united kingdom|uk|england|london|scotland|wales)\b/],
  ['US', /\b(united states|usa|u s a|washington dc|atlanta|new york|boston|seattle)\b/],
  ['BE', /\b(belgium|brussels)\b/],
  ['NL', /\b(netherlands|amsterdam|the hague)\b/],
  ['DK', /\b(denmark|copenhagen)\b/],
  ['DE', /\b(germany|berlin|munich|bonn|hamburg|frankfurt|cologne|stuttgart)\b/],
  ['FR', /\b(france|paris|lyon)\b/],
  ['IN', /\b(india|new delhi|mumbai|bengaluru|bangalore)\b/],
  ['PH', /\b(philippines|manila)\b/],
  ['TH', /\b(thailand|bangkok)\b/],
  ['AU', /\b(australia|sydney|melbourne|canberra)\b/],
  ['CA', /\b(canada|toronto|ottawa|montreal|vancouver)\b/],
];

export function resolveCountry(...parts: Array<string | null | undefined>): string | null {
  const haystack = ` ${canonical(parts.filter(Boolean).join(' '))} `;
  const hits = COUNTRY_PATTERNS.filter(([, pattern]) => pattern.test(haystack)).map(([code]) => code);
  const distinct = Array.from(new Set(hits));
  // Exactly one country mentioned -> confident. Zero or several -> unknown.
  return distinct.length === 1 ? (distinct[0] as string) : null;
}

/** Broad regions, used by filters like `.jobs africa`. */
export const AFRICA_COUNTRIES = new Set([
  'KE', 'UG', 'TZ', 'RW', 'ET', 'NG', 'GH', 'ZA', 'SS', 'SO', 'SD',
  'ZM', 'ZW', 'MW', 'MZ', 'BW', 'NA', 'CD', 'CM', 'SN', 'CI', 'EG', 'MA',
]);

/**
 * Remote-work detection.
 *
 * Returns null, not false, when the text says nothing — "we don't know" and
 * "definitely on-site" are different facts and `.jobs remote` must not show a
 * listing on the strength of a missing field.
 */
export function detectRemote(...parts: Array<string | null | undefined>): boolean | null {
  const haystack = ` ${canonical(parts.filter(Boolean).join(' '))} `;
  if (/\b(fully remote|remote first|work from home|work from anywhere|telecommut|100 percent remote|remote position|remote role|anywhere)\b/.test(haystack)) {
    return true;
  }
  if (/\b(on ?site|in ?person|in office|office based|hybrid|duty station)\b/.test(haystack)) return false;
  if (/\bremote\b/.test(haystack)) return true;
  return null;
}
