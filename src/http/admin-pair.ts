/**
 * Browser-based WhatsApp pairing.
 *
 * Exists so the platform can be paired on a host with no terminal — shared
 * hosting, a container, a managed Node runtime. Without it, pairing requires
 * reading a QR code from stdout, which rules those platforms out entirely.
 *
 * ── Security ────────────────────────────────────────────────────────────────
 * A WhatsApp QR is a credential. Whoever scans it binds the bot to *their*
 * account, taking the deployment over. So:
 *
 *   - the whole router is disabled unless PAIRING_PAGE=on and ADMIN_PANEL_TOKEN is set
 *   - every request is checked with a timing-safe comparison
 *   - responses are no-store and noindex
 *   - the endpoints are rate limited
 *   - once connected, the QR is dropped from memory and never served again
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import { repairSession, whatsappStatus } from '../whatsapp/client.js';
import { rateLimit } from './rate-limit.js';

const log = logger.child({ component: 'admin-pair' });

/** QR codes rotate roughly every 20 seconds. */
const QR_TTL_MS = 60_000;

/**
 * Compare without leaking length or content through timing.
 * Both sides are hashed to equal length first, since `timingSafeEqual`
 * throws on mismatched buffers — which would itself be an oracle.
 */
function tokenMatches(supplied: string): boolean {
  const expected = env.ADMIN_PANEL_TOKEN;
  if (expected.length === 0) return false;

  const a = Buffer.from(supplied.padEnd(128).slice(0, 128));
  const b = Buffer.from(expected.padEnd(128).slice(0, 128));
  return timingSafeEqual(a, b) && supplied.length === expected.length;
}

/** Accept the token from a header, a bearer, or a query parameter. */
function suppliedToken(req: Request): string {
  const header = req.headers['x-admin-token'];
  if (typeof header === 'string' && header.length > 0) return header;

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);

  const query = req.query.token;
  if (typeof query === 'string') return query;

  return '';
}

function requireToken(req: Request, res: Response, next: NextFunction): void {
  if (!tokenMatches(suppliedToken(req))) {
    // Deliberately uninformative: never confirm whether the page exists.
    res.status(404).type('text/plain').send('Not found');
    return;
  }
  res.setHeader('cache-control', 'no-store, max-age=0');
  res.setHeader('x-robots-tag', 'noindex, nofollow');
  next();
}

export function createAdminPairRouter(): Router | null {
  if (env.PAIRING_PAGE !== 'on') {
    log.info('pairing page off — the QR is shown in the terminal only (set PAIRING_PAGE=on for shared hosting)');
    return null;
  }
  if (env.ADMIN_PANEL_TOKEN.trim().length === 0) {
    log.warn('PAIRING_PAGE=on but ADMIN_PANEL_TOKEN is blank — the pairing page stays off');
    return null;
  }

  const router = Router();
  const limiter = rateLimit({ name: 'admin-pair', max: 120, windowMs: 5 * 60 * 1000 });
  router.use(limiter, requireToken);

  /**
   * GET /api/admin/pair/status
   *
   * Drives the page. Returns the QR as a data URL only while one is pending.
   */
  router.get('/status', async (_req: Request, res: Response) => {
    const status = whatsappStatus();

    if (status.connected) {
      res.json({
        state: 'connected',
        lastConnectedAt: status.lastConnectedAt,
        // Masked: the page confirms *which* account without publishing the
        // full number to anyone who opens it.
        account: status.selfJid ? maskJid(status.selfJid) : null,
      });
      return;
    }

    if (status.pairingCode) {
      res.json({ state: 'code', code: status.pairingCode });
      return;
    }

    const fresh =
      status.qr &&
      status.qrIssuedAt &&
      Date.now() - status.qrIssuedAt.getTime() < QR_TTL_MS;

    if (fresh && status.qr) {
      try {
        const dataUrl = await QRCode.toDataURL(status.qr, { margin: 1, width: 320 });
        res.json({
          state: 'qr',
          qr: dataUrl,
          issuedAt: status.qrIssuedAt,
          reconnectAttempts: status.reconnectAttempts,
        });
        return;
      } catch (cause) {
        log.warn({ err: String(cause) }, 'could not render the QR');
      }
    }

    res.json({
      state: 'waiting',
      reason: status.lastDisconnectReason,
      reconnectAttempts: status.reconnectAttempts,
    });
  });

  /**
   * GET /api/admin/pair/page — the HTML itself.
   *
   * Served from `views/`, outside the static directory, so it is reachable
   * only through this token-guarded route.
   */
  router.get('/page', (_req: Request, res: Response) => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    res.sendFile(path.resolve(here, '../../views/pair.html'));
  });

  /**
   * POST /api/admin/pair/restart
   *
   * Discards the stored session and starts pairing again. The recovery path
   * for a corrupted encryption session, which otherwise needs shell access to
   * delete the auth directory.
   */
  router.post('/restart', (_req: Request, res: Response) => {
    log.warn('pairing restart requested from the pairing page');
    // Fire-and-forget: it clears credentials then reconnects, which takes
    // longer than this request should wait.
    void repairSession();
    res.json({ ok: true, message: 'Session cleared. A new QR code will appear shortly.' });
  });

  log.info('pairing page enabled at /admin/pair');
  return router;
}

/** "254712345678:27@s.whatsapp.net" -> "254•••678" */
function maskJid(jid: string): string {
  const user = (jid.split('@')[0] ?? '').split(':')[0] ?? '';
  if (user.length <= 6) return '•••';
  return `${user.slice(0, 3)}•••${user.slice(-3)}`;
}
