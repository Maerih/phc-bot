/**
 * Operational HTTP surface.
 *
 * Deliberately minimal and deliberately anonymous: it reports whether the
 * platform is healthy and which sources are active, and nothing about any
 * member. The previous WOLFBOT status page published the owner's phone number
 * in plain JSON on an unauthenticated endpoint — this one exposes no personal
 * data at all, so it is safe to leave reachable for monitoring.
 *
 * The Phase 5 admin dashboard will mount behind authentication, separately
 * from these public probes.
 */
import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { env } from '../config/env.js';
import { createAdminPairRouter } from './admin-pair.js';
import { createSearchRouter } from './search-api.js';
import { logger } from '../core/logger.js';
import { countAll } from '../db/repositories/opportunities.js';
import { countActiveMembers, countMembers } from '../db/repositories/members.js';
import { describeSources } from '../search/search.service.js';
import { allCommands } from '../commands/registry.js';
import { whatsappStatus } from '../whatsapp/client.js';

const log = logger.child({ component: 'http' });

const startedAt = Date.now();

function uptimeSeconds(): number {
  return Math.floor((Date.now() - startedAt) / 1000);
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  // Baseline hardening for the web UI. No inline-script allowance beyond the
  // page's own bundled script, no framing, no referrer leakage to the
  // third-party application pages we link out to.
  app.use((_req: Request, res: Response, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader(
      'content-security-policy',
      [
        "default-src 'self'",
        // The single-page UI keeps its script and styles inline, so these are
        // required; there are no third-party script or style origins.
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join('; '),
    );
    next();
  });

  // Public search API — the same search service the WhatsApp commands use.
  app.use('/api', createSearchRouter());

  // Browser pairing, for hosts with no terminal. Disabled unless
  // ADMIN_PANEL_TOKEN is set, and token-guarded when it is.
  const pairRouter = createAdminPairRouter();
  if (pairRouter) {
    app.use('/api/admin/pair', pairRouter);
    // Friendly entry point: /admin/pair?token=... serves the same page.
    app.get('/admin/pair', (req: Request, res: Response) => {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      res.redirect(302, `/api/admin/pair/page?token=${encodeURIComponent(token)}`);
    });
  }

  // Web UI. `dist/http` is two levels below the project root at runtime, so
  // the path is resolved relative to this module rather than to cwd, which
  // would break when the process is started from anywhere else.
  const here = path.dirname(fileURLToPath(import.meta.url));
  app.use(
    express.static(path.resolve(here, '../../public'), {
      maxAge: env.NODE_ENV === 'production' ? '1h' : 0,
      index: 'index.html',
    }),
  );

  /** Liveness/readiness probe. */
  app.get('/health', (_req: Request, res: Response) => {
    const wa = whatsappStatus();
    res.status(wa.connected ? 200 : 503).json({
      status: wa.connected ? 'ok' : 'degraded',
      whatsapp: wa.connected ? 'connected' : 'disconnected',
      uptimeSeconds: uptimeSeconds(),
    });
  });

  /** Operational status. Contains no member or owner identifiers. */
  app.get('/api/status', async (_req: Request, res: Response) => {
    const wa = whatsappStatus();

    // Counts come from the database, which may be briefly unavailable; the
    // endpoint should still answer rather than 500 a monitoring check.
    const [opportunities, members, activeMembers] = await Promise.all([
      countAll().catch(() => null),
      countMembers().catch(() => null),
      countActiveMembers(7).catch(() => null),
    ]);

    res.json({
      platform: 'Public Health Colosseum',
      poweredBy: 'SCIAT SOLUTIONS',
      status: wa.connected ? 'ok' : 'degraded',
      environment: env.NODE_ENV,
      uptimeSeconds: uptimeSeconds(),
      whatsapp: {
        connected: wa.connected,
        lastConnectedAt: wa.lastConnectedAt,
        reconnectAttempts: wa.reconnectAttempts,
        // The code itself is a credential for linking a device, so it is never
        // published — only whether one is currently pending.
        pairingPending: wa.pairingCode !== null,
      },
      commands: allCommands().length,
      prefix: env.COMMAND_PREFIX,
      ai: { provider: env.AI_PROVIDER },
      sources: describeSources().map((source) => ({
        slug: source.slug,
        name: source.name,
        enabled: source.enabled && !source.unavailableReason,
      })),
      counts: { opportunities, members, activeMembers },
      timestamp: new Date().toISOString(),
    });
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' });
  });

  return app;
}

export function startHttpServer(): Promise<Server> {
  const app = createApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(env.PORT, () => {
      log.info({ port: env.PORT }, 'http server listening');
      resolve(server);
    });
    server.once('error', reject);
  });
}
