import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = new Map<string, string>();
vi.mock('./store.js', () => ({
  getSetting: async (key: string) => settings.get(key) ?? null,
  setSetting: async (key: string, value: string) => void settings.set(key, value),
}));

const { aiMayAnswer, openSession, ownerTookOver, resetDmMode, setAiMode, setChatStopped } = await import('./dm-mode.js');

const FRIEND = '254711111111@s.whatsapp.net';
const MEMBER = '254722222222@s.whatsapp.net';

describe('when the AI may answer a private chat', () => {
  beforeEach(() => {
    settings.clear();
    resetDmMode();
  });

  it('is off by default: friends reach the owner', async () => {
    expect(await aiMayAnswer(FRIEND)).toBe(false);
  });

  it('answers someone who started with an AI command, until the owner takes over', async () => {
    openSession(MEMBER);
    expect(await aiMayAnswer(MEMBER)).toBe(true);
    expect(await aiMayAnswer(FRIEND)).toBe(false);
    ownerTookOver(MEMBER);
    expect(await aiMayAnswer(MEMBER)).toBe(false);
  });

  it('answers everyone when on, except chats taken over or stopped', async () => {
    await setAiMode(true);
    expect(await aiMayAnswer(FRIEND)).toBe(true);
    ownerTookOver(FRIEND);
    expect(await aiMayAnswer(FRIEND)).toBe(false);
    await setChatStopped(MEMBER, true);
    expect(await aiMayAnswer(MEMBER)).toBe(false);
    openSession(MEMBER);
    expect(await aiMayAnswer(MEMBER)).toBe(false);
    await setChatStopped(MEMBER, false);
    expect(await aiMayAnswer(MEMBER)).toBe(true);
  });

  it('ends a conversation after 30 quiet minutes', async () => {
    vi.useFakeTimers();
    openSession(MEMBER);
    vi.advanceTimersByTime(31 * 60_000);
    expect(await aiMayAnswer(MEMBER)).toBe(false);
    vi.useRealTimers();
  });
});
