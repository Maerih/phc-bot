/**
 * Exclusive lock on the WhatsApp auth directory.
 *
 * Two processes sharing one auth directory is the single most destructive
 * failure this platform has. Each advances the Signal encryption ratchet
 * independently, the key state diverges, and every incoming message fails to
 * decrypt with `Bad MAC`. The socket stays "connected", `/health` reports
 * `ok`, and commands silently do nothing — so it looks like a bug anywhere
 * except where it actually is. Recovery is deleting the session and pairing
 * again; there is no repair.
 *
 * It has happened twice here: once from concurrent test instances, once from
 * `npm run dev` started while another instance was already running. On shared
 * hosting it is a standing risk, because Passenger may spawn several workers.
 *
 * So the second process refuses to start rather than corrupting the session.
 * A loud failure at boot is enormously better than a silent one at runtime.
 */
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, closeSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../core/logger.js';

const log = logger.child({ component: 'session-lock' });

const LOCK_FILE = '.lock';

export class SessionLockedError extends Error {
  constructor(
    readonly holderPid: number,
    readonly lockPath: string,
  ) {
    super(
      `Another instance (pid ${holderPid}) is already using this WhatsApp session.\n` +
        `  Only one process may use ${path.dirname(lockPath)} at a time — two will corrupt it\n` +
        `  permanently and the bot will silently stop responding.\n\n` +
        `  Stop the other instance first:  kill ${holderPid}\n` +
        `  If you are certain it is gone:   rm ${lockPath}`,
    );
    this.name = 'SessionLockedError';
  }
}

/** Is a process with this id currently running? */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission and existence check without signalling.
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means it exists but belongs to another user — still alive.
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take the lock, or throw `SessionLockedError` if another live process holds it.
 *
 * A lock left behind by a crashed process is reclaimed: the pid inside is
 * checked, and a dead one is treated as stale. Otherwise an unclean shutdown
 * would require manual intervention before the bot could restart.
 */
export function acquireSessionLock(authDir: string): string {
  mkdirSync(authDir, { recursive: true });
  const lockPath = path.join(authDir, LOCK_FILE);

  if (existsSync(lockPath)) {
    const holder = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);

    if (isAlive(holder) && holder !== process.pid) {
      throw new SessionLockedError(holder, lockPath);
    }

    log.warn({ stalePid: holder }, 'reclaiming a stale session lock from a process that is gone');
    try {
      unlinkSync(lockPath);
    } catch {
      // Raced with another starter; the exclusive create below decides.
    }
  }

  try {
    // 'wx' fails if the file appeared since the check, which closes the race
    // between two processes starting at the same moment.
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      const holder = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
      throw new SessionLockedError(holder, lockPath);
    }
    throw cause;
  }

  log.info({ pid: process.pid }, 'session lock acquired');
  return lockPath;
}

/** Release the lock, but only if this process still owns it. */
export function releaseSessionLock(authDir: string): void {
  const lockPath = path.join(authDir, LOCK_FILE);
  try {
    if (!existsSync(lockPath)) return;
    const holder = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    if (holder !== process.pid) return; // not ours to remove
    unlinkSync(lockPath);
    log.info('session lock released');
  } catch (cause) {
    log.debug({ err: String(cause) }, 'could not release the session lock');
  }
}
