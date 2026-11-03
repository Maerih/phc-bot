/**
 * Is a listing about public health? The keyword side of the answer.
 *
 * With DeepSeek configured these rules only decide what is worth asking it
 * about on general job boards; without it they are the whole decision, so
 * they are written to be right on their own.
 */
import type { OpportunityType } from '../domain/opportunity.js';

/** Public health and its neighbours, as they appear in Kenyan listings. */
const PUBLIC_HEALTH =
  /\b(public health|mph|msc public health|master of public health|community health|chvs?|chps?|community health (promoter|volunteer|assistant|officer)s?|health records?|health information|hrio|hmis|medical records?|health informatics|population health|occupational (health|safety)|health and safety|ohs|epidemiolog\w*|biostatistic\w*|disease surveillance|surveillance officer|environmental health|public health officer|wash\b|water,? sanitation|sanitation|hygiene|nutrition\w*|dietitian|dietician|health promotion|health education|global health|health systems?|health policy|health economics?|health financing|maternal|newborn|child health|reproductive health|family planning|srh|hiv|aids|tuberculosis|\btb\b|malaria|immuni[sz]ation|vaccin\w*|ncds?|non-communicable|mental health|one health|health program\w*|health project|health officer|m&e|monitoring and evaluation|health research|clinical research|research assistant|data officer|health data|primary health care|phc|uhc|universal health)\b/i;

/** Broadly health-flavoured words: enough to be worth asking the AI about. */
const HEALTHISH =
  /\b(health|medical|clinic\w*|hospital|nurs\w*|doctor|physician|pharmac\w*|laborator\w*|lab tech|patient|disease|hiv|malaria|tb|nutrition|sanitation|wash|epidemiolog\w*|biostatistic\w*|surveillance|kemri|amref|aphrc|moh|who|unicef|unaids|usaid)\b/i;

/** Words that mark a link as an opportunity rather than a news item or page. */
const OPPORTUNITY_WORDS =
  /\b(vacanc\w*|job|jobs|position|officer|manager|coordinator|assistant|associate|specialist|advisor|adviser|analyst|consultant|consultancy|intern\w*|attachment|fellowship|scholarship|grant|call for|recruit\w*|hiring|careers?|opportunit\w*|volunteer\w*|trainee|graduate|programme|program|award|funding|apply|deadline)\b/i;

export function isPublicHealth(text: string): boolean {
  return PUBLIC_HEALTH.test(text);
}

export function isHealthish(text: string): boolean {
  return HEALTHISH.test(text) || PUBLIC_HEALTH.test(text);
}

export function looksLikeOpportunity(text: string): boolean {
  return OPPORTUNITY_WORDS.test(text);
}

/** Labels of documents and pages rather than of one opportunity. */
const GENERIC_TITLE =
  /^(job descriptions?|.*information sheet|careers?|current (vacancies|openings)|vacancies|jobs|downloads?|tenders?|internships?|attachments?|scholarships?|fellowships?|opportunities|calls and opportunities|calls for (applications|proposals)|apply here|how to apply|application forms?)\.?$/i;

export function isGenericTitle(title: string): boolean {
  return GENERIC_TITLE.test(title.trim());
}

/** The keyword-only verdict, used when no AI is available. */
export function keywordVerdict(title: string, healthSite: boolean): boolean {
  if (isGenericTitle(title)) return false;
  if (!looksLikeOpportunity(title) && !isPublicHealth(title)) return false;
  return isPublicHealth(title) || (healthSite && looksLikeOpportunity(title));
}

/** The kind of opportunity a title describes, when it says so. */
export function typeFromTitle(title: string, fallback: OpportunityType): OpportunityType {
  if (/\bintern(ship)?s?\b|\battachment\b|\btrainee\b/i.test(title)) return 'INTERNSHIP';
  if (/\bscholarships?\b|\bbursar(y|ies)\b/i.test(title)) return 'SCHOLARSHIP';
  if (/\bfellowships?\b|\bfellows\b/i.test(title)) return 'FELLOWSHIP';
  if (/\bvolunteer/i.test(title)) return 'VOLUNTEER';
  if (/\bgrants?\b|\bfunding\b|\bcall for proposals\b/i.test(title)) return 'GRANT';
  if (/\bconference\b|\bsummit\b|\bcall for abstracts\b/i.test(title)) return 'CONFERENCE';
  if (/\btraining\b|\bcourse\b|\bworkshop\b|\bbootcamp\b/i.test(title)) return 'TRAINING';
  if (/\bvacanc|\bjob\b|\bofficer\b|\bmanager\b|\bcoordinator\b|\bassistant\b|\bconsultan/i.test(title)) return 'JOB';
  return fallback;
}
