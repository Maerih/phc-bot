import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireSessionLock, releaseSessionLock, SessionLockedError } from './session-lock.js';

const dirs: string[] = [];

function tempAuthDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'phc-lock-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('session lock', () => {
  it('acquires a lock and records the owning pid', () => {
    const dir = tempAuthDir();
    const lockPath = acquireSessionLock(dir);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
  });

  it('refuses to start when a live process holds the lock', () => {
    // The whole point: a second instance must fail loudly at boot rather than
    // silently corrupting the Signal session at runtime.
    const dir = tempAuthDir();
    // pid 1 always exists, standing in for another running instance.
    writeFileSync(path.join(dir, '.lock'), '1');
    expect(() => acquireSessionLock(dir)).toThrow(SessionLockedError);
  });

  it('explains how to recover', () => {
    const dir = tempAuthDir();
    writeFileSync(path.join(dir, '.lock'), '1');
    try {
      acquireSessionLock(dir);
      expect.unreachable('should have thrown');
    } catch (cause) {
      const message = (cause as Error).message;
      expect(message).toMatch(/only one process/i);
      expect(message).toContain('kill 1');
    }
  });

  it('reclaims a lock left by a process that is gone', () => {
    // An unclean shutdown must not require manual intervention to restart.
    const dir = tempAuthDir();
    // A pid that cannot be running: above the maximum on Linux.
    writeFileSync(path.join(dir, '.lock'), '4194305');
    const lockPath = acquireSessionLock(dir);
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid));
  });

  it('is re-entrant for the same process', () => {
    const dir = tempAuthDir();
    acquireSessionLock(dir);
    expect(() => acquireSessionLock(dir)).not.toThrow();
  });

  it('releases only a lock it owns', () => {
    const dir = tempAuthDir();
    const lockPath = path.join(dir, '.lock');

    acquireSessionLock(dir);
    releaseSessionLock(dir);
    expect(existsSync(lockPath)).toBe(false);

    // A lock belonging to someone else must survive our release.
    writeFileSync(lockPath, '1');
    releaseSessionLock(dir);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('creates the auth directory when it does not exist', () => {
    const dir = path.join(tempAuthDir(), 'nested', 'auth');
    expect(() => acquireSessionLock(dir)).not.toThrow();
    expect(existsSync(path.join(dir, '.lock'))).toBe(true);
  });
});
