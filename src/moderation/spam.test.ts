import { describe, expect, it } from 'vitest';
import { SpamTracker } from './spam.js';

const LONG = 'Cheap loans available now, no paperwork needed at all';

describe('SpamTracker', () => {
  it('flags flooding beyond the burst limit', () => {
    const tracker = new SpamTracker();
    const verdicts = Array.from({ length: 7 }, (_, i) => tracker.record('g1', 'u1', `message number ${i}`, 1000 + i * 100));
    expect(verdicts.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(verdicts[6]).toBe('flood');
  });

  it('forgets bursts once the window passes', () => {
    const tracker = new SpamTracker();
    for (let i = 0; i < 6; i++) tracker.record('g1', 'u1', `msg ${i}`, i * 100);
    expect(tracker.record('g1', 'u1', 'later', 60_000)).toBeNull();
  });

  it('flags the same message repeated in one group', () => {
    const tracker = new SpamTracker();
    expect(tracker.record('g1', 'u1', LONG, 0)).toBeNull();
    expect(tracker.record('g1', 'u1', LONG, 60_000)).toBeNull();
    expect(tracker.record('g1', 'u1', `${LONG}!!`, 120_000)).toBe('repeat');
  });

  it('flags cross-posting across groups', () => {
    const tracker = new SpamTracker();
    expect(tracker.record('g1', 'u1', LONG, 0)).toBeNull();
    expect(tracker.record('g2', 'u1', LONG, 1000)).toBeNull();
    expect(tracker.record('g3', 'u1', LONG, 2000)).toBe('crosspost');
  });

  it('keeps members apart', () => {
    const tracker = new SpamTracker();
    tracker.record('g1', 'u1', LONG, 0);
    tracker.record('g2', 'u2', LONG, 0);
    expect(tracker.record('g3', 'u3', LONG, 0)).toBeNull();
  });

  it('never counts short messages as repeats', () => {
    const tracker = new SpamTracker();
    for (let i = 0; i < 5; i++) expect(tracker.record('g1', 'u1', 'Thanks!', i * 60_000)).toBeNull();
  });
});
