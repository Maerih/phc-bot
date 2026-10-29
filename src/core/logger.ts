/**
 * Structured logging.
 *
 * One root logger; every subsystem takes a bound child via `logger.child({...})`
 * so log lines are filterable by component. Phone numbers and WhatsApp JIDs are
 * personal data, so `redactJid` is used wherever an identifier reaches a log.
 */
import pino from 'pino';
import { env } from '../config/env.js';

const isDev = env.NODE_ENV === 'development';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'phc-platform' },
  // Defence in depth: if a raw credential or JID is ever attached to a log
  // object by mistake, pino removes it before the line is written.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.apiKey',
      '*.password',
      '*.sessionId',
      'jid',
      '*.jid',
    ],
    censor: '[redacted]',
  },
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          // destination 2 = stderr. Logs must not share stdout with CLI
          // output, or piping `npm run search -- --json` into a parser breaks.
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service', destination: 2 },
        },
      }
    : {}),
}, isDev ? undefined : pino.destination(2));

/**
 * Turn a WhatsApp JID into something safe to log: keeps enough to correlate
 * events for one member without writing their phone number to disk.
 *
 *   "254712345678@s.whatsapp.net" -> "254***678@s.whatsapp.net"
 */
export function redactJid(jid: string | null | undefined): string {
  if (!jid) return '(none)';
  const atIndex = jid.indexOf('@');
  const user = atIndex === -1 ? jid : jid.slice(0, atIndex);
  const domain = atIndex === -1 ? '' : jid.slice(atIndex);
  if (user.length <= 6) return `***${domain}`;
  return `${user.slice(0, 3)}***${user.slice(-3)}${domain}`;
}

export type Logger = pino.Logger;
