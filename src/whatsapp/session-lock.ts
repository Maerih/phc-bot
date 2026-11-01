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
 * So the second process refuses to start rather than corrupting the session.
 * A loud failure at boot is enormously better than a silent one at runtime.
 *
 * The lock works across containers, not just processes. A process id alone
 * cannot: every container's main process is pid 1, so two containers sharing
 * the folder would each take the other's lock for their own. Instead the
 * holder records who it is and touches the lock every few seconds. A lock
 * that has been touched recently belongs to someone alive, wherever they run;
 * one that has gone quiet is left over from a copy that stopped, and is
 * reclaimed without anyone having to delete it by hand.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { logger } from '../core/logger.js';

const log = logger.child({ component: 'session-lock' });

const LOCK_FILE = '.lock';

/** How often the holder proves it is alive. */
export const HEARTBEAT_MS = 10_000;
/** A lock not touched for this long belongs to a copy that is gone. */
export const STALE_AFTER_MS = 30_000;

/** Identifies this process, even where pids repeat (containers, restarts). */
const INSTANCE_ID = randomUUID();

interface LockRecord {
  id: string;
  pid: number;
  host: string;
  startedAt: string;
}

interface LockState {
  /** Null for a lock written by an older version: a bare pid. */
  record: LockRecord | null;
  legacyPid: number | null;
  /** Time since the holder last touched the lock. */
  ageMs: number;
}

let heartbeat: ReturnType<typeof setInterval> | null = null;

export class SessionLockedError extends Error {
  constructor(
    readonly holder: { pid: number; host: string | null; ageMs: number },
    readonly lockPath: string,
  ) {
    const where = holder.host ? `pid ${holder.pid} on ${holder.host}` : `pid ${holder.pid}`;
    super(
      `Another copy of the bot (${where}) is already using this WhatsApp session;\n` +
        `  it was last active ${Math.round(holder.ageMs / 1000)} seconds ago.\n` +
        `  Only one process may use ${path.dirname(lockPath)} at a time — two will corrupt it\n` +
        `  permanently and the bot will silently stop responding.\n\n` +
        `  Stop the other copy first. With ./ctl.sh, "./ctl.sh doctor" shows where it runs.\n` +
        `  The lock frees itself ${STALE_AFTER_MS / 1000} seconds after the other copy stops.`,
    );
    this.name = 'SessionLockedError';
  }
}

/** Is a process with this id currently running on this machine? */
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

function readLock(lockPath: string): LockState | null {
  let text: string;
  let mtimeMs: number;
  try {
    text = readFileSync(lockPath, 'utf8').trim();
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return null; // vanished in between: nobody holds it
  }
  const ageMs = Math.max(0, Date.now() - mtimeMs);
  if (/^\d+$/.test(text)) return { record: null, legacyPid: Number(text), ageMs };
  try {
    const parsed = JSON.parse(text) as Partial<LockRecord>;
    if (typeof parsed.id === 'string' && typeof parsed.pid === 'number' && typeof parsed.host === 'string') {
      return { record: parsed as LockRecord, legacyPid: null, ageMs };
    }
  } catch {
    // Unreadable: treat as abandoned below.
  }
  return { record: null, legacyPid: null, ageMs };
}

/** Does this lock belong to another copy that is running right now? */
function heldByAnother(state: LockState): boolean {
  const { record, legacyPid, ageMs } = state;

  if (record) {
    if (record.id === INSTANCE_ID) return false; // this very process
    if (ageMs >= STALE_AFTER_MS) return false; // its holder stopped touching it
    if (record.host === hostname()) {
      // Same machine or container: the pid is meaningful here. Our own pid
      // with a different id is a previous run of this same container.
      return record.pid !== process.pid && isAlive(record.pid);
    }
    return true; // another container or machine, active within the window
  }

  // Written by an older version, which kept no heartbeat: judge by the pid.
  if (legacyPid !== null) return legacyPid !== process.pid && isAlive(legacyPid);
  return false; // unreadable
}

function lockedError(state: LockState, lockPath: string): SessionLockedError {
  return new SessionLockedError(
    {
      pid: state.record?.pid ?? state.legacyPid ?? 0,
      host: state.record?.host ?? null,
      ageMs: state.ageMs,
    },
    lockPath,
  );
}

function ownLock(lockPath: string): boolean {
  return readLock(lockPath)?.record?.id === INSTANCE_ID;
}

/** Prove this process is still alive, and notice if the lock was taken over. */
export function beatSessionLock(lockPath: string): void {
  if (!existsSync(lockPath)) {
    // Deleted by hand while we run: put it back, it is still ours.
    writeLock(lockPath);
    return;
  }
  if (!ownLock(lockPath)) {
    // Another copy reclaimed it — only possible if this process stalled for
    // longer than the stale window. Two copies must never keep running, and
    // the other has the lock, so this one leaves.
    log.fatal('another copy took over the WhatsApp session lock; stopping this one so only one runs');
    process.exit(70);
  }
  const now = new Date();
  utimesSync(lockPath, now, now);
}

function writeLock(lockPath: string): void {
  const record: LockRecord = {
    id: INSTANCE_ID,
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
  };
  // 'wx' fails if the file appeared since the check, which closes the race
  // between two processes starting at the same moment.
  const fd = openSync(lockPath, 'wx');
  try {
    writeSync(fd, JSON.stringify(record));
  } finally {
    closeSync(fd);
  }
}

/**
 * Take the lock, or throw `SessionLockedError` if another running copy holds it.
 *
 * Re-entrant: calling it again from the same process just refreshes the lock.
 */
export function acquireSessionLock(authDir: string): string {
  mkdirSync(authDir, { recursive: true });
  const lockPath = path.join(authDir, LOCK_FILE);

  const existing = readLock(lockPath);
  if (existing) {
    if (existing.record?.id === INSTANCE_ID) {
      beatSessionLock(lockPath);
      return lockPath;
    }
    if (heldByAnother(existing)) throw lockedError(existing, lockPath);

    log.warn(
      { previousHost: existing.record?.host, previousPid: existing.record?.pid ?? existing.legacyPid },
      'taking over a session lock left by a copy that has stopped',
    );
    try {
      unlinkSync(lockPath);
    } catch {
      // Raced with another starter; the exclusive create below decides.
    }
  }

  try {
    writeLock(lockPath);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      const winner = readLock(lockPath);
      throw lockedError(winner ?? { record: null, legacyPid: null, ageMs: 0 }, lockPath);
    }
    throw cause;
  }

  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    try {
      beatSessionLock(lockPath);
    } catch (cause) {
      log.warn({ err: String(cause) }, 'could not refresh the session lock');
    }
  }, HEARTBEAT_MS);
  // The heartbeat alone must never keep the process alive.
  heartbeat.unref();

  log.info({ pid: process.pid, host: hostname() }, 'session lock acquired');
  return lockPath;
}

/** Release the lock, but only if this process still owns it. */
export function releaseSessionLock(authDir: string): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  const lockPath = path.join(authDir, LOCK_FILE);
  try {
    if (!ownLock(lockPath)) return; // not ours to remove
    unlinkSync(lockPath);
    log.info('session lock released');
  } catch (cause) {
    log.debug({ err: String(cause) }, 'could not release the session lock');
  }
}
