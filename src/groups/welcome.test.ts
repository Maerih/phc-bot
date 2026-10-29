import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WELCOME, joinNames, renderWelcome, WelcomeBatcher } from './welcome.js';

describe('joinNames', () => {
  it('reads naturally for one, two and many', () => {
    expect(joinNames(['@a'])).toBe('@a');
    expect(joinNames(['@a', '@b'])).toBe('@a and @b');
    expect(joinNames(['@a', '@b', '@c'])).toBe('@a, @b and @c');
  });

  it('summarises the rest', () => {
    expect(joinNames(['@a', '@b'], 12)).toBe('@a, @b and 12 others');
    expect(joinNames(['@a'], 1)).toBe('@a and 1 other');
  });
});

describe('renderWelcome', () => {
  it('uses the standard message when the group has none', () => {
    const text = renderWelcome(null, { tags: ['@254700000001'], group: 'PHC Nairobi' });
    expect(text).toContain('Welcome to *PHC Nairobi*, @254700000001!');
    expect(DEFAULT_WELCOME).toContain('{name}');
  });

  it('fills in a custom message', () => {
    expect(renderWelcome('Karibu {name} to {group}!', { tags: ['@a', '@b'], group: 'Epi Club' })).toBe(
      'Karibu @a and @b to Epi Club!',
    );
  });

  it('still tags newcomers when a custom message forgets {name}', () => {
    expect(renderWelcome('Please read the rules.', { tags: ['@a'], group: 'G' })).toBe('@a\n\nPlease read the rules.');
  });

  it('treats a blank custom message as none', () => {
    expect(renderWelcome('   ', { tags: ['@a'], group: 'G' })).toContain('Welcome to *G*');
  });
});

describe('WelcomeBatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('welcomes people who join together in one message', async () => {
    const send = vi.fn(async () => undefined);
    const batcher = new WelcomeBatcher(send, { windowMs: 5000, minGapMs: 60_000 });

    batcher.add('g1', ['a@s.whatsapp.net']);
    await vi.advanceTimersByTimeAsync(2000);
    batcher.add('g1', ['b@s.whatsapp.net', 'a@s.whatsapp.net']);
    await vi.advanceTimersByTimeAsync(3000);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('g1', ['a@s.whatsapp.net', 'b@s.whatsapp.net']);
  });

  it('keeps groups apart', async () => {
    const send = vi.fn(async () => undefined);
    const batcher = new WelcomeBatcher(send, { windowMs: 5000, minGapMs: 60_000 });
    batcher.add('g1', ['a@s.whatsapp.net']);
    batcher.add('g2', ['b@s.whatsapp.net']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends at most one welcome a minute per group', async () => {
    const send = vi.fn(async () => undefined);
    const batcher = new WelcomeBatcher(send, { windowMs: 5000, minGapMs: 60_000 });

    batcher.add('g1', ['a@s.whatsapp.net']);
    await vi.advanceTimersByTimeAsync(5000);
    batcher.add('g1', ['b@s.whatsapp.net']);
    await vi.advanceTimersByTimeAsync(10_000);
    batcher.add('g1', ['c@s.whatsapp.net']);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(send).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('g1', ['b@s.whatsapp.net', 'c@s.whatsapp.net']);
  });

  it('ignores an empty join and survives a failed send', async () => {
    const onError = vi.fn();
    const batcher = new WelcomeBatcher(
      async () => {
        throw new Error('not allowed to send');
      },
      { windowMs: 5000, minGapMs: 0 },
      onError,
    );
    batcher.add('g1', []);
    batcher.add('g2', ['a@s.whatsapp.net']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onError).toHaveBeenCalledOnce();
  });
});
