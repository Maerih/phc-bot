/**
 * The websites the tracker watches for public-health opportunities.
 *
 * Every entry was checked on 3 November 2026: it answers, it serves its
 * listings as HTML rather than only through JavaScript, and its robots.txt
 * allows reading it. Left out on purpose:
 *  - sites whose terms forbid automated collection or that need a login:
 *    LinkedIn, Indeed, Glassdoor, Upwork, FlexJobs, Contra, Wellfound;
 *  - JavaScript-only listings with nothing to read: WHO, UN Careers, UNV,
 *    apply.co.ke, Career Kenya, AttachKE;
 *  - sites that refuse automated access or disallow it in robots.txt:
 *    UNDP, NIH, Himalayas, EURAXESS.
 * ReliefWeb is covered by its own API connector instead.
 *
 * `health` marks sites where nearly everything is health-related, so every
 * listing there is considered; on general boards only listings whose titles
 * look health-related are.
 */
import type { OpportunityType } from '../domain/opportunity.js';

export interface TrackedSite {
  slug: string;
  name: string;
  url: string;
  health: boolean;
  /** What the site mostly lists, used when a listing does not say. */
  defaultType: OpportunityType;
  /** True for Kenya-focused sites, so listings default to Kenya. */
  kenya: boolean;
  /** The site is the employer or funder itself, so its own pages are the original. */
  employer: boolean;
}

function site(
  slug: string,
  name: string,
  url: string,
  options: { health?: boolean; type?: OpportunityType; kenya?: boolean; employer?: boolean } = {},
): TrackedSite {
  return {
    slug,
    name,
    url,
    health: options.health ?? false,
    defaultType: options.type ?? 'JOB',
    kenya: options.kenya ?? true,
    employer: options.employer ?? false,
  };
}

export const TRACKED_SITES: readonly TrackedSite[] = [
  // ── Kenyan job boards ──
  site('jobopenings', 'Job Openings Kenya', 'https://jobopenings.co.ke/'),
  site('brightermonday', 'BrighterMonday', 'https://www.brightermonday.co.ke/jobs/medical-healthcare', { health: true }),
  site('brightermonday-ngo', 'BrighterMonday (NGO)', 'https://www.brightermonday.co.ke/jobs/ngo-ngo-non-profit'),
  site('myjobmag', 'MyJobMag Kenya', 'https://www.myjobmag.co.ke/jobs'),
  site('fuzu', 'Fuzu', 'https://www.fuzu.com/kenya/job/healthcare', { health: true }),
  site('ofyk', 'Opportunities for Young Kenyans', 'https://opportunitiesforyoungkenyans.co.ke/'),
  site('ajirahub', 'Ajira Hub', 'https://ajirahub.co.ke/'),
  site('ajirika', 'Ajirika', 'https://ajirika.com/jobs-in-kenya'),
  site('workke', 'Work Kenya', 'https://work.ke/jobs'),
  site('workke-intern', 'Work Kenya (internships)', 'https://work.ke/jobs/internships', { type: 'INTERNSHIP' }),
  site('vacancyke', 'VacancyKE', 'https://www.vacancy.co.ke/jobs'),
  site('vacancyke-intern', 'VacancyKE (internships)', 'https://www.vacancy.co.ke/internships', { type: 'INTERNSHIP' }),
  site('vacancyke-ngo', 'VacancyKE (NGO & UN)', 'https://www.vacancy.co.ke/ngo-jobs'),
  site('jobbasekenya', 'Job Base Kenya', 'https://www.jobbasekenya.com/'),
  site('careerpointkenya', 'Career Point Kenya', 'https://www.careerpointkenya.co.ke/'),
  site('jobwebkenya', 'JobWeb Kenya', 'https://www.jobwebkenya.com/'),
  site('jobsinkenya', 'Jobs in Kenya', 'https://www.jobsinkenya.co.ke/'),

  // ── Public-health searches on Kenyan boards ──
  // Listings that never reach a board's front page, found by searching it
  // for each public-health field.
  site('jw-public-health', 'JobWeb Kenya: public health', 'https://www.jobwebkenya.com/?s=public+health', { health: true }),
  site('jw-community-health', 'JobWeb Kenya: community health', 'https://www.jobwebkenya.com/?s=community+health', { health: true }),
  site('jw-health-records', 'JobWeb Kenya: health records', 'https://www.jobwebkenya.com/?s=health+records', { health: true }),
  site('jw-environmental-health', 'JobWeb Kenya: environmental health', 'https://www.jobwebkenya.com/?s=environmental+health', { health: true }),
  site('jw-occupational-health', 'JobWeb Kenya: occupational health', 'https://www.jobwebkenya.com/?s=occupational+health', { health: true }),
  site('jw-epidemiology', 'JobWeb Kenya: epidemiology', 'https://www.jobwebkenya.com/?s=epidemiology', { health: true }),
  site('jw-nutrition', 'JobWeb Kenya: nutrition', 'https://www.jobwebkenya.com/?s=nutrition', { health: true }),
  site('jw-health-me', 'JobWeb Kenya: health M&E', 'https://www.jobwebkenya.com/?s=monitoring+evaluation+health', { health: true }),
  site('jw-population-health', 'JobWeb Kenya: population health', 'https://www.jobwebkenya.com/?s=population+health', { health: true }),
  site('jw-wash', 'JobWeb Kenya: WASH', 'https://www.jobwebkenya.com/?s=water+sanitation+hygiene', { health: true }),
  site('ofyk-health', 'Opportunities for Young Kenyans: health', 'https://opportunitiesforyoungkenyans.co.ke/?s=health', { health: true }),

  // ── Government ──
  site('psc', 'Public Service Commission', 'https://psckjobs.go.ke/', { employer: true }),
  site('gaa', 'Government Advertising Agency', 'https://gaa.go.ke/job-adverts', { employer: true }),
  site('moh', 'Ministry of Health', 'https://www.health.go.ke/', { health: true, employer: true }),
  site('kmtc', 'Kenya Medical Training College', 'https://kmtc.ac.ke/', { health: true, employer: true }),
  site('kemri', 'KEMRI', 'https://www.kemri.go.ke/careers/', { health: true, employer: true }),
  site('kemri-contract', 'KEMRI e-recruitment (contract)', 'https://erecruitment.kemri.go.ke:7070/Home/ContractJobs', { health: true, employer: true }),
  site('kemri-permanent', 'KEMRI e-recruitment (permanent)', 'https://erecruitment.kemri.go.ke:7070/Home/PermanentJobs', { health: true, employer: true }),
  site('knh', 'Kenyatta National Hospital', 'https://knh.or.ke/', { health: true, employer: true }),
  site('mtrh', 'Moi Teaching and Referral Hospital', 'https://www.mtrh.go.ke/', { health: true, employer: true }),
  site('cpsb-transnzoia', 'Trans Nzoia County Public Service Board', 'https://www.cpsbtransnzoia.co.ke/vacancies', { employer: true }),
  site('cpsb-kiambu', 'Kiambu County Public Service Board', 'https://kiambu.go.ke/cpsb/', { employer: true }),
  site('maseno', 'Maseno University', 'https://www.maseno.ac.ke/vacancies', { employer: true }),

  // ── Health research, NGOs and programmes in Kenya ──
  site('kemri-wellcome', 'KEMRI-Wellcome Trust', 'https://kemri-wellcome.org/careers/', { health: true, employer: true }),
  site('aphrc', 'APHRC', 'https://aphrc.org/careers/', { health: true, employer: true }),
  site('amref', 'Amref Health Africa', 'https://amref.org/careers/', { health: true, employer: true }),
  site('amref-vacancies', 'Amref Health Africa (vacancies)', 'https://amref.org/vacancies/', { health: true, employer: true }),
  site('redcross', 'Kenya Red Cross', 'https://www.redcross.or.ke/careers/', { health: true, employer: true }),
  site('livinggoods', 'Living Goods', 'https://livinggoods.org/careers/', { health: true, employer: true }),
  site('path', 'PATH', 'https://www.path.org/careers/', { health: true, kenya: false, employer: true }),
  site('africacdc', 'Africa CDC', 'https://africacdc.org/opportunities/', { health: true, kenya: false, employer: true }),
  site('pskenya', 'Population Services Kenya', 'https://pskenya.org/careers/', { health: true, employer: true }),
  site('mariestopes', 'Marie Stopes Kenya', 'https://mariestopes.or.ke/careers/', { health: true, employer: true }),
  site('aku', 'Aga Khan University', 'https://www.aku.edu/careers/Pages/home.aspx', { health: true, employer: true }),
  site('cmmb', 'CMMB', 'https://cmmb.org/careers/', { health: true, kenya: false, employer: true }),
  site('savethechildren-ke', 'Save the Children Kenya', 'https://kenya.savethechildren.net/careers', { employer: true }),
  site('kndi', 'Kenya Nutritionists and Dieticians Institute', 'https://kndi.institute/careers/', { health: true, employer: true }),
  site('healthsystemsglobal', 'Health Systems Global', 'https://www.healthsystemsglobal.org/', { health: true, kenya: false, type: 'PROGRAM' }),

  // ── NGO, UN and development ──
  site('impactpool', 'Impactpool', 'https://www.impactpool.org/countries/Kenya'),
  site('unkenya', 'UN Kenya', 'https://kenya.un.org/en/jobs', { employer: true }),
  site('unicef', 'UNICEF', 'https://jobs.unicef.org/', { kenya: false, employer: true }),
  site('wfp', 'WFP', 'https://www.wfp.org/careers', { kenya: false, employer: true }),
  site('ngojobsafrica', 'NGO Jobs in Africa', 'https://ngojobsinafrica.com/', { kenya: false }),
  site('pollsafrica', 'PollsAfrica', 'https://pollsafrica.com/jobs/kenya'),
  site('tikuranbesa', 'Tikuranbesa', 'https://tikuranbesa.com/jobs/', { kenya: false }),
  site('afdb', 'African Development Bank', 'https://www.afdb.org/en/about-us/careers', { kenya: false, employer: true }),
  site('au', 'African Union', 'https://careers.au.int/', { kenya: false, employer: true }),
  site('worldbank', 'World Bank', 'https://www.worldbank.org/en/about/careers', { kenya: false, employer: true }),

  // ── Scholarships, fellowships, grants, volunteering ──
  site('openopps', 'Open Opportunities', 'https://openopportunities.org/opportunities-country/kenya/', { type: 'PROGRAM' }),
  site('uplift360', 'Uplift 360 Africa', 'https://uplift360africa.org/opportunities/', { type: 'PROGRAM' }),
  site('opportunitydesk', 'Opportunity Desk', 'https://opportunitydesk.org/', { type: 'PROGRAM', kenya: false }),
  site('wemakescholars', 'WeMakeScholars', 'https://www.wemakescholars.com/', { type: 'SCHOLARSHIP', kenya: false }),
  site('daadkenya', 'DAAD Kenya', 'https://www.daad-kenya.org/', { type: 'SCHOLARSHIP', employer: true }),
  site('mastercardfdn', 'Mastercard Foundation', 'https://mastercardfdn.org/', { type: 'SCHOLARSHIP', kenya: false, employer: true }),
  site('scholars4dev', 'Scholars4Dev (public health)', 'https://www.scholars4dev.com/category/subject/public-health-scholarships/', { health: true, type: 'SCHOLARSHIP', kenya: false }),
  site('afterschoolafrica', 'After School Africa', 'https://www.afterschoolafrica.com/', { type: 'SCHOLARSHIP', kenya: false }),
  site('opportunitiesforafricans', 'Opportunities for Africans', 'https://www.opportunitiesforafricans.com/', { type: 'PROGRAM', kenya: false }),
  site('cartafrica', 'CARTA', 'https://cartafrica.org/', { health: true, type: 'FELLOWSHIP', kenya: false, employer: true }),
  site('fogarty', 'Fogarty International Center', 'https://www.fic.nih.gov/Funding/Pages/default.aspx', { health: true, type: 'GRANT', kenya: false, employer: true }),
  site('wellcome', 'Wellcome', 'https://wellcome.org/grant-funding/schemes', { health: true, type: 'GRANT', kenya: false, employer: true }),
  site('ghc', 'Global Health Corps', 'https://ghcorps.org/', { health: true, type: 'FELLOWSHIP', kenya: false, employer: true }),
  site('vso', 'VSO', 'https://www.vsointernational.org/volunteering', { type: 'VOLUNTEER', kenya: false, employer: true }),
  site('mitsolve', 'MIT Solve', 'https://solve.mit.edu/', { type: 'PROGRAM', kenya: false, employer: true }),
  site('tef', 'Tony Elumelu Foundation', 'https://www.tonyelumelufoundation.org/', { type: 'GRANT', kenya: false, employer: true }),

  // ── Remote and international ──
  site('remoteok', 'Remote OK (health)', 'https://remoteok.com/remote-health-jobs', { health: true, kenya: false }),
  site('weworkremotely', 'We Work Remotely', 'https://weworkremotely.com/', { kenya: false }),
  site('remotive-web', 'Remotive', 'https://remotive.com/', { kenya: false }),
  site('workingnomads', 'Working Nomads', 'https://www.workingnomads.com/jobs', { kenya: false }),
];
