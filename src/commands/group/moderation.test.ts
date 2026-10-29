import { describe, expect, it } from 'vitest';
import { parseAction, parseDuration } from './moderation.js';

describe('parseAction', () => {
  it('reads "on" as delete, since warning alone rarely stops a spammer', () => {
    expect(parseAction('on')).toBe('DELETE');
  });

  it('accepts every action in any case', () => {
    expect(parseAction('Warn')).toBe('WARN');
    expect(parseAction('REMOVE')).toBe('REMOVE');
    expect(parseAction('off')).toBe('OFF');
  });

  it('rejects anything else', () => {
    expect(parseAction('kick')).toBeNull();
    expect(parseAction(undefined)).toBeNull();
  });
});

describe('parseDuration', () => {
  it('reads minutes, hours and days', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('2h')).toBe(2 * 3_600_000);
    expect(parseDuration('1D')).toBe(86_400_000);
  });

  it('caps at 30 days and rejects zero or nonsense', () => {
    expect(parseDuration('30d')).toBe(30 * 86_400_000);
    expect(parseDuration('31d')).toBeNull();
    expect(parseDuration('0m')).toBeNull();
    expect(parseDuration('soon')).toBeNull();
  });
});
