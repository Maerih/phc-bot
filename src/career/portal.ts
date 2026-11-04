/// <reference lib="dom" />
/**
 * Assisted portal applications.
 *
 * Only a simple, public form is ever filled: no login, no password field, no
 * CAPTCHA, and every required field mapped to something the member gave.
 * Anything else is left to the member with a fill-in sheet. Filling and
 * submitting are separate steps: the member sees a screenshot of the filled
 * form and must confirm before it is sent.
 */
import type { Page } from 'playwright-core';
import { withPage } from './browser.js';

export interface FormInspection {
  fillable: boolean;
  reason: string;
}

export interface FormData {
  fullName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  location: string | null;
  coverLetter: string;
  cv: { name: string; mimeType: string; buffer: Buffer };
  letter?: { name: string; mimeType: string; buffer: Buffer };
}

const BLOCKERS = /captcha|recaptcha|hcaptcha|turnstile|cf-challenge/i;

/** Describe the form fields on the page, with their labels. */
async function readFields(page: Page): Promise<Array<{ index: number; tag: string; type: string; label: string; required: boolean }>> {
  return page.evaluate(() => {
    const out: Array<{ index: number; tag: string; type: string; label: string; required: boolean }> = [];
    // The application form is the one with a file upload (a search or job-alert box has none).
    const forms = Array.from(document.querySelectorAll('form'));
    const form = forms.find((candidate) => candidate.querySelector('input[type=file]')) ?? forms[0];
    if (!form) return out;
    const elements = Array.from(form.querySelectorAll('input, textarea, select'));
    elements.forEach((element, index) => {
      const el = element as HTMLInputElement;
      const type = (el.getAttribute('type') ?? el.tagName).toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) return;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const id = el.id;
      const labelFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent ?? '' : '';
      const wrapping = el.closest('label')?.textContent ?? '';
      const label = [labelFor, wrapping, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name'), id].filter(Boolean).join(' ');
      out.push({ index, tag: el.tagName.toLowerCase(), type, label: label.replace(/\s+/g, ' ').trim().toLowerCase(), required: el.required || el.getAttribute('aria-required') === 'true' });
    });
    return out;
  });
}

type Field = Awaited<ReturnType<typeof readFields>>[number];

/** What to put in a field, or undefined when the member's details do not cover it. */
function valueFor(field: Field, data: FormData): string | 'cv' | 'letter' | undefined {
  const label = field.label;
  if (field.type === 'file') return /cover|letter|motivation/.test(label) ? (data.letter ? 'letter' : undefined) : 'cv';
  if (/e-?mail/.test(label)) return data.email ?? undefined;
  if (/phone|mobile|tel|cell/.test(label) || field.type === 'tel') return data.phone ?? undefined;
  if (/first.?name|given/.test(label)) return data.firstName;
  if (/last.?name|surname|family/.test(label)) return data.lastName;
  if (/full.?name|^name\b|\bname\b/.test(label)) return data.fullName;
  if (/location|city|town|address|county/.test(label)) return data.location ?? undefined;
  if (field.tag === 'textarea' && /cover|letter|message|motivation|why|about/.test(label)) return data.coverLetter;
  return undefined;
}

/** Can the bot fill this form? Read-only: nothing is typed or sent. */
export function inspectForm(url: string): Promise<FormInspection> {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const html = await page.content();
    if (BLOCKERS.test(html)) return { fillable: false, reason: 'the form has a CAPTCHA' };
    if ((await page.locator('input[type=password]').count()) > 0) return { fillable: false, reason: 'the portal needs an account and password' };
    if ((await page.locator('form').count()) === 0) return { fillable: false, reason: 'there is no form on the page' };
    const fields = await readFields(page);
    if (fields.length < 2 || !fields.some((field) => field.type === 'file') || !fields.some((field) => field.type === 'email' || /e-?mail/.test(field.label))) {
      return { fillable: false, reason: 'the page has no application form with a CV upload' };
    }
    const probe: FormData = {
      fullName: 'x', firstName: 'x', lastName: 'x', email: 'x', phone: 'x', location: 'x', coverLetter: 'x',
      cv: { name: 'cv.pdf', mimeType: 'application/pdf', buffer: Buffer.from('') },
      letter: { name: 'letter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('') },
    };
    const unmapped = fields.filter((field) => field.required && valueFor(field, probe) === undefined);
    if (unmapped.length > 0) return { fillable: false, reason: `it asks for things I cannot answer for you (${unmapped.slice(0, 3).map((field) => field.label.slice(0, 30)).join('; ')})` };
    return { fillable: true, reason: 'a simple public form' };
  }, 60_000);
}

/** The same form readFields chose: the first with a file upload, else the first form. */
async function applicationForm(page: Page) {
  const withUpload = page.locator('form').filter({ has: page.locator('input[type=file]') });
  return (await withUpload.count()) > 0 ? withUpload.first() : page.locator('form').first();
}

/** A reference number in the site's reply: a code containing a digit, after a word like "reference". */
export function referenceIn(text: string): string | null {
  for (const match of text.matchAll(/(?:reference|confirmation|tracking|application)(?:\s+(?:reference|no\.?|number|id|code))*\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/gi)) {
    if (/\d/.test(match[1]!)) return match[1]!;
  }
  return null;
}

async function fill(page: Page, url: string, data: FormData): Promise<string[]> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const fields = await readFields(page);
  const elements = (await applicationForm(page)).locator('input, textarea, select');
  const filled: string[] = [];
  for (const field of fields) {
    const value = valueFor(field, data);
    if (value === undefined) continue;
    const element = elements.nth(field.index);
    if (value === 'cv') await element.setInputFiles({ name: data.cv.name, mimeType: data.cv.mimeType, buffer: data.cv.buffer });
    else if (value === 'letter' && data.letter) await element.setInputFiles({ name: data.letter.name, mimeType: data.letter.mimeType, buffer: data.letter.buffer });
    else if (field.tag === 'select') continue;
    else await element.fill(value);
    filled.push(field.label.slice(0, 40) || field.type);
  }
  return filled;
}

/** Fill the form and photograph it. Nothing is submitted. */
export function previewForm(url: string, data: FormData): Promise<{ screenshot: Buffer; filled: string[] }> {
  return withPage(async (page) => {
    const filled = await fill(page, url, data);
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    return { screenshot: Buffer.from(screenshot), filled };
  }, 90_000);
}

/** Fill and submit, after the member confirmed. Reports what the site said back. */
export function submitForm(url: string, data: FormData): Promise<{ screenshot: Buffer; confirmed: boolean; reference: string | null; message: string }> {
  return withPage(async (page) => {
    await fill(page, url, data);
    const button = (await applicationForm(page)).locator('button[type=submit], input[type=submit], button:not([type])').first();
    await Promise.all([page.waitForLoadState('networkidle').catch(() => undefined), button.click()]);
    await page.waitForTimeout(2000);
    const text = (await page.locator('body').innerText()).slice(0, 4000);
    const confirmed = /thank you|received|submitted|success|we will be in touch|application (has been|was) (sent|received)/i.test(text);
    const reference = referenceIn(text);
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    return { screenshot: Buffer.from(screenshot), confirmed, reference, message: text.slice(0, 300) };
  }, 120_000);
}
