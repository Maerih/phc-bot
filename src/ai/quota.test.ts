import { beforeEach, describe, expect, it } from 'vitest';
import { AI_CALLS_PER_HOUR, consumeAiQuota, resetAiQuota } from './quota.js';

describe('consumeAiQuota', () => {
  beforeEach(() => {
    resetAiQuota();
  });

  it('allows the first call and reports the remaining budget', () => {
    const decision = consumeAiQuota('member-1');
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(AI_CALLS_PER_HOUR - 1);
  });

  it('allows exactly the configured number of calls', () => {
    for (let i = 0; i < AI_CALLS_PER_HOUR; i += 1) {
      expect(consumeAiQuota('member-1').allowed, `call ${i + 1}`).toBe(true);
    }
    expect(consumeAiQuota('member-1').allowed).toBe(false);
  });

  it('reports when the window resets once exhausted', () => {
    for (let i = 0; i < AI_CALLS_PER_HOUR; i += 1) consumeAiQuota('member-1');
    const blocked = consumeAiQuota('member-1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetInMinutes).toBeGreaterThan(0);
    expect(blocked.resetInMinutes).toBeLessThanOrEqual(60);
  });

  it('tracks members independently', () => {
    // One member exhausting their budget must not affect anyone else.
    for (let i = 0; i < AI_CALLS_PER_HOUR; i += 1) consumeAiQuota('member-1');
    expect(consumeAiQuota('member-1').allowed).toBe(false);
    expect(consumeAiQuota('member-2').allowed).toBe(true);
  });

  it('starts a fresh window after an hour', () => {
    const start = Date.now();
    for (let i = 0; i < AI_CALLS_PER_HOUR; i += 1) consumeAiQuota('member-1', start);
    expect(consumeAiQuota('member-1', start).allowed).toBe(false);

    const later = start + 60 * 60 * 1000 + 1;
    const renewed = consumeAiQuota('member-1', later);
    expect(renewed.allowed).toBe(true);
    expect(renewed.remaining).toBe(AI_CALLS_PER_HOUR - 1);
  });
});
