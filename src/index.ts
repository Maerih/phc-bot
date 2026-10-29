/**
 * Entry point.
 *
 * Startup order is chosen so failures are loud and early: configuration, then
 * the database, then HTTP, and only then WhatsApp. Connecting to WhatsApp
 * before the database is reachable would leave members talking to a bot that
 * cannot answer.
 */
import type { Server } from 'node:http';
import { quietLibsignal } from './core/quiet-libsignal.js';
import { env, isAiConfigured } from './config/env.js';
import { logger } from './core/logger.js';
import { assertDatabaseReachable, closeDatabase, runMigrations } from './db/client.js';
import { startHttpServer } from './http/server.js';
import { startWhatsApp, stopWhatsApp } from './whatsapp/client.js';
import { acquireSessionLock } from './whatsapp/session-lock.js';
import { activeConnectors } from './sources/registry.js';
import { flushPersistence } from './search/search.service.js';
import { allCommands } from './commands/registry.js';

const log = logger.child({ component: 'bootstrap' });

quietLibsignal();

let httpServer: Server | null = null;

async function main(): Promise<void> {
  log.info(
    {
      environment: env.NODE_ENV,
      timezone: env.TIMEZONE,
      commands: allCommands().length,
      sources: activeConnectors().map((connector) => connector.meta.slug),
      aiProvider: env.AI_PROVIDER,
      aiReady: isAiConfigured(),
    },
    'Public Health Colosseum platform starting — powered by SCIAT SOLUTIONS',
  );

  if (env.AI_PROVIDER !== 'none' && !isAiConfigured()) {
    // Stated plainly rather than failing: every non-AI feature still works.
    log.warn(
      { provider: env.AI_PROVIDER },
      'AI_PROVIDER is set but no API key is configured — AI features stay disabled, search and commands are unaffected',
    );
  }

  if (activeConnectors().length === 0) {
    log.warn('no opportunity sources are enabled — set SOURCES_ENABLED in .env');
  }

  // Claimed before anything else binds or connects, so a duplicate instance
  // fails with a clear explanation rather than a confusing port conflict.
  acquireSessionLock(env.WHATSAPP_AUTH_DIR);

  await assertDatabaseReachable();
  await runMigrations();
  httpServer = await startHttpServer();
  await startWhatsApp();

  log.info('startup complete');
}

/** Shut down cleanly so WhatsApp credentials and the DB pool are not corrupted. */
async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');

  const closeHttp = new Promise<void>((resolve) => {
    if (!httpServer) return resolve();
    httpServer.close(() => resolve());
  });

  await Promise.allSettled([stopWhatsApp(), closeHttp]);
  // Discovered opportunities are written in the background; finish those
  // writes before the pool closes, or they are lost.
  await flushPersistence().catch(() => undefined);
  await closeDatabase().catch(() => undefined);

  log.info('shutdown complete');
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

// A rejected promise must not silently kill a subsystem and leave the process
// half-alive; log it and keep serving what still works.
process.on('unhandledRejection', (reason) => {
  log.error({ err: reason instanceof Error ? reason.stack : String(reason) }, 'unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  log.fatal({ err: error.stack }, 'uncaught exception — exiting');
  process.exit(1);
});

main().catch((cause) => {
  // A session-lock failure is an operator mistake, not a crash: print the
  // instructions plainly rather than burying them in a stack trace.
  if (cause instanceof Error && cause.name === 'SessionLockedError') {
    process.stderr.write(`\nRefusing to start.\n\n  ${cause.message}\n\n`);
    process.exit(1);
  }
  log.fatal({ err: cause instanceof Error ? cause.message : String(cause) }, 'startup failed');
  process.exit(1);
});
