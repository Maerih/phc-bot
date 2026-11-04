/**
 * One headless Chromium for the whole bot: PDFs from HTML, and assisted
 * portal applications. One page at a time — the server is shared with other
 * applications — and every use has a timeout.
 */
import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import { logger } from '../core/logger.js';

const log = logger.child({ component: 'browser' });

const CANDIDATES = [process.env.CHROMIUM_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];

let browser: Browser | null = null;
let queue: Promise<unknown> = Promise.resolve();

export function chromiumPath(): string | null {
  return CANDIDATES.find((path): path is string => Boolean(path) && existsSync(path as string)) ?? null;
}

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  const executablePath = chromiumPath();
  if (!executablePath) throw new Error('Chromium is not installed');
  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'],
  });
  browser.on('disconnected', () => {
    browser = null;
  });
  log.info('browser started');
  return browser;
}

/** Run `task` with a fresh page, after any task already running. */
export function withPage<T>(task: (page: Page) => Promise<T>, timeoutMs = 90_000): Promise<T> {
  const run = queue.then(async () => {
    const instance = await getBrowser();
    const context = await instance.newContext({ userAgent: 'PHC-Platform/0.1 (+https://github.com/Maerih/phc-bot)' });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task(page),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('browser task timed out')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      await context.close().catch(() => undefined);
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Render HTML to an A4 PDF. */
export function htmlToPdf(html: string): Promise<Buffer> {
  return withPage(async (page) => {
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '0', bottom: '0', left: '0', right: '0' } });
    return Buffer.from(pdf);
  });
}

export async function closeBrowser(): Promise<void> {
  await browser?.close().catch(() => undefined);
  browser = null;
}
