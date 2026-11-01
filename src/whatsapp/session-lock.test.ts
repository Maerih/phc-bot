import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import {
  acquireSessionLock,
  beatSessionLock,
  releaseSessionLock,
  SessionLockedError,
  STALE_AFTER_MS,
} from './session-lock.js';

const dirs: string[] = [];

function tempAuthDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'phc-lock-'));
  dirs.push(dir);
  return dir;
}

/** A lock as another copy of the bot would write it. */
function foreignLock(dir: string, fields: { pid?: number; host?: string; ageMs?: number } = {}): string {
  const lockPath = path.join(dir, '.lock');
  writeFileSync(
    lockPath,
    JSON.stringify({
      id: 'someone-else',
      pid: fields.pid ?? 1,
      host: fields.host ?? 'another-container',
      startedAt: new Date().toISOString(),
    }),
  );
  if (fields.ageMs) {
    const then = new Date(Date.now() - fields.ageMs);
    utimesSync(lockPath, then, then);
  }
  return lockPath;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    releaseSessionLock(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('session lock', () => {
  it('acquires a lock and records who holds it', () => {
    const dir = tempAuthDir();
    const lockPath = acquireSessionLock(dir);
    const record = JSON.parse(readFileSync(lockPath, 'utf8'));
    expect(record.pid).toBe(process.pid);
    expect(record.host).toBe(hostname());
  });

  it('refuses while another container holds an active lock', () => {
    // The case a pid cannot catch: in every container the bot is pid 1. Two
    // containers on one session must still find out about each other.
    const dir = tempAuthDir();
    foreignLock(dir, { pid: 1, host: 'another-container' });
    expect(() => acquireSessionLock(dir)).toThrow(SessionLockedError);
  });

  it('takes over a lock whose holder went quiet', () => {
    // A copy that stopped without cleaning up must not block the next start.
    const dir = tempAuthDir();
    foreignLock(dir, { host: 'another-container', ageMs: STALE_AFTER_MS + 5_000 });
    const lockPath = acquireSessionLock(dir);
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).host).toBe(hostname());
  });

  it('takes over a lock from a previous run of this same container', () => {
    // After a restart the container keeps its hostname and the bot is pid 1
    // again: same host and pid, but a different run.
    const dir = tempAuthDir();
    foreignLock(dir, { pid: process.pid, host: hostname() });
    expect(() => acquireSessionLock(dir)).not.toThrow();
  });

  it('takes over a lock on this machine whose process has exited', () => {
    const dir = tempAuthDir();
    // Above the maximum pid on Linux, so it cannot be running.
    foreignLock(dir, { pid: 4194305, host: hostname() });
    expect(() => acquireSessionLock(dir)).not.toThrow();
  });

  it('refuses while a live process on this machine holds it', () => {
    const dir = tempAuthDir();
    // pid 1 always exists, standing in for another running instance.
    foreignLock(dir, { pid: 1, host: hostname() });
    expect(() => acquireSessionLock(dir)).toThrow(SessionLockedError);
  });

  it('explains what is happening and how it resolves', () => {
    const dir = tempAuthDir();
    foreignLock(dir, { pid: 1, host: 'another-container' });
    try {
      acquireSessionLock(dir);
      expect.unreachable('should have thrown');
    } catch (cause) {
      const message = (cause as Error).message;
      expect(message).toMatch(/only one process/i);
      expect(message).toContain('another-container');
      expect(message).toMatch(/frees itself/);
    }
  });

  it('still understands locks written by older versions', () => {
    const dir = tempAuthDir();
    writeFileSync(path.join(dir, '.lock'), '1');
    expect(() => acquireSessionLock(dir)).toThrow(SessionLockedError);

    writeFileSync(path.join(dir, '.lock'), '4194305');
    expect(() => acquireSessionLock(dir)).not.toThrow();
  });

  it('is re-entrant for the same process', () => {
    const dir = tempAuthDir();
    acquireSessionLock(dir);
    expect(() => acquireSessionLock(dir)).not.toThrow();
  });

  it('heartbeat keeps the lock fresh', () => {
    const dir = tempAuthDir();
    const lockPath = acquireSessionLock(dir);
    const then = new Date(Date.now() - 20_000);
    utimesSync(lockPath, then, then);
    beatSessionLock(lockPath);
    expect(Date.now() - statSync(lockPath).mtimeMs).toBeLessThan(5_000);
  });

  it('releases only a lock it owns', () => {
    const dir = tempAuthDir();
    const lockPath = path.join(dir, '.lock');

    acquireSessionLock(dir);
    releaseSessionLock(dir);
    expect(existsSync(lockPath)).toBe(false);

    // A lock belonging to someone else must survive our release.
    foreignLock(dir);
    releaseSessionLock(dir);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('creates the auth directory when it does not exist', () => {
    const dir = path.join(tempAuthDir(), 'nested', 'auth');
    expect(() => acquireSessionLock(dir)).not.toThrow();
    expect(existsSync(path.join(dir, '.lock'))).toBe(true);
  });
});
