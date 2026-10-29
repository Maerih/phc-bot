import { describe, expect, it, vi } from 'vitest';
import { logger } from '../core/logger.js';
import {
  enforce,
  evaluate,
  NoticeThrottle,
  type EnforceIO,
  type EvaluateDeps,
  type ModeratedMessage,
  type ModerationSettings,
  type Violation,
} from './engine.js';
import { SpamTracker } from './spam.js';

const OFF: ModerationSettings = {
  antilink: 'OFF',
  antibadword: 'OFF',
  antipromo: 'OFF',
  antispam: 'OFF',
  linkScope: 'INVITES',
  allowedDomains: [],
  bannedWords: [],
  aiReview: false,
  warnLimit: 3,
};

function message(text: string, overrides: Partial<ModeratedMessage> = {}): ModeratedMessage {
  return {
    groupJid: 'group@g.us',
    senderJid: '254700000001@s.whatsapp.net',
    senderLid: '111@lid',
    text,
    forwardingScore: 0,
    ...overrides,
  };
}

function deps(settings: Partial<ModerationSettings> | null, overrides: Partial<EvaluateDeps> = {}): EvaluateDeps {
  return {
    settings: settings === null ? null : { ...OFF, ...settings },
    silencedIds: new Set(),
    tracker: new SpamTracker(),
    isExempt: async () => false,
    ...overrides,
  };
}

const INVITE = 'join https://chat.whatsapp.com/AbC123';
const ADVERT = 'I sell cheap phones, Ksh 3,000 only. DM me, free delivery';

describe('evaluate', () => {
  it('does nothing in a group nobody configured', async () => {
    expect(await evaluate(message(INVITE), deps(null))).toBeNull();
  });

  it('does nothing when every rule is off', async () => {
    expect(await evaluate(message(`${INVITE} ${ADVERT}`), deps({}))).toBeNull();
  });

  it('catches invite links', async () => {
    const violation = await evaluate(message(INVITE), deps({ antilink: 'DELETE' }));
    expect(violation).toMatchObject({ rule: 'antilink', action: 'DELETE' });
  });

  it('leaves ordinary links alone unless the scope is ALL', async () => {
    const text = 'Apply here https://who.int/careers';
    expect(await evaluate(message(text), deps({ antilink: 'DELETE' }))).toBeNull();
    expect(await evaluate(message(text), deps({ antilink: 'DELETE', linkScope: 'ALL' }))).toMatchObject({
      rule: 'antilink',
    });
    expect(
      await evaluate(message(text), deps({ antilink: 'DELETE', linkScope: 'ALL', allowedDomains: ['who.int'] })),
    ).toBeNull();
  });

  it('catches adverts', async () => {
    expect(await evaluate(message(ADVERT), deps({ antipromo: 'WARN' }))).toMatchObject({ rule: 'antipromo' });
  });

  it('catches banned words without repeating them in the reason', async () => {
    const violation = await evaluate(message('best betting here'), deps({ antibadword: 'DELETE', bannedWords: ['betting'] }));
    expect(violation?.rule).toBe('antibadword');
    expect(violation?.reason).not.toContain('betting');
  });

  it('catches flooding', async () => {
    const shared = deps({ antispam: 'DELETE' });
    let last = null;
    for (let i = 0; i < 7; i++) last = await evaluate(message(`hello number ${i}`), { ...shared, now: i * 100 });
    expect(last).toMatchObject({ rule: 'antispam', action: 'DELETE' });
  });

  it('never moderates an exempt sender', async () => {
    const isExempt = vi.fn(async () => true);
    expect(await evaluate(message(INVITE), deps({ antilink: 'REMOVE' }, { isExempt }))).toBeNull();
    expect(isExempt).toHaveBeenCalledOnce();
  });

  it('does not look up exemption for messages that break no rule', async () => {
    const isExempt = vi.fn(async () => false);
    await evaluate(message('Good morning, colleagues'), deps({ antilink: 'DELETE', antipromo: 'DELETE' }, { isExempt }));
    expect(isExempt).not.toHaveBeenCalled();
  });

  it('picks the strictest rule when several fire', async () => {
    const violation = await evaluate(message(`${ADVERT} ${INVITE}`), deps({ antilink: 'WARN', antipromo: 'REMOVE' }));
    expect(violation).toMatchObject({ rule: 'antipromo', action: 'REMOVE' });
  });

  it('deletes anything a silenced member posts, by either id', async () => {
    const silenced = deps(null, { silencedIds: new Set(['111@lid']) });
    expect(await evaluate(message(''), silenced)).toMatchObject({ rule: 'silence', action: 'DELETE' });
  });

  it('asks the AI only about borderline posts, and only when allowed', async () => {
    const aiReview = vi.fn(async () => true);
    const borderline = 'We sell a few things, have a look'; // scores 3: suspicious, not certain
    const settings = { antipromo: 'DELETE' as const, aiReview: true };

    expect(await evaluate(message(borderline), deps(settings, { aiReview }))).toMatchObject({ rule: 'antipromo' });
    expect(aiReview).toHaveBeenCalledOnce();

    aiReview.mockClear();
    await evaluate(message(borderline), deps({ ...settings, aiReview: false }, { aiReview }));
    await evaluate(message('Good morning all'), deps(settings, { aiReview }));
    expect(aiReview).not.toHaveBeenCalled();
  });

  it('never acts when the AI is undecided', async () => {
    const aiReview = vi.fn(async () => null);
    const result = await evaluate(
      message('We sell a few things, have a look'),
      deps({ antipromo: 'DELETE', aiReview: true }, { aiReview }),
    );
    expect(result).toBeNull();
  });
});

function io(overrides: Partial<EnforceIO> = {}): EnforceIO & { notes: string[] } {
  const notes: string[] = [];
  let warnings = 0;
  return {
    notes,
    botIsAdmin: async () => true,
    deleteMessage: vi.fn(async () => undefined),
    issueWarning: vi.fn(async () => ++warnings),
    removeSender: vi.fn(async () => true),
    notify: vi.fn(async (text: string) => {
      notes.push(text);
    }),
    log: logger,
    ...overrides,
  };
}

function throttles() {
  return { warningThrottle: new NoticeThrottle(60_000), notAdminThrottle: new NoticeThrottle(3_600_000) };
}

const linkViolation = (action: Violation['action']): Violation => ({ rule: 'antilink', action, reason: 'links are not allowed here' });

describe('enforce', () => {
  it('warn only: warns, never deletes', async () => {
    const effects = io();
    expect(await enforce(message(INVITE), linkViolation('WARN'), OFF, effects, throttles())).toBe('warned');
    expect(effects.deleteMessage).not.toHaveBeenCalled();
    expect(effects.notes[0]).toContain('Warning 1/3');
  });

  it('delete: deletes and warns', async () => {
    const effects = io();
    expect(await enforce(message(INVITE), linkViolation('DELETE'), OFF, effects, throttles())).toBe('deleted');
    expect(effects.deleteMessage).toHaveBeenCalledOnce();
    expect(effects.issueWarning).toHaveBeenCalledOnce();
  });

  it('remove: removes only at the warning limit', async () => {
    const effects = io();
    const options = throttles();
    const settings = { warnLimit: 2 };
    expect(await enforce(message(INVITE), linkViolation('REMOVE'), settings, effects, options)).toBe('deleted');
    expect(effects.removeSender).not.toHaveBeenCalled();
    expect(
      await enforce(message(INVITE), linkViolation('REMOVE'), settings, effects, { ...options, now: Date.now() + 61_000 }),
    ).toBe('removed');
    expect(effects.removeSender).toHaveBeenCalledOnce();
  });

  it('a burst is one offence: one warning per rule per minute, every message still deleted', async () => {
    const effects = io();
    const options = throttles();
    for (let i = 0; i < 5; i++) await enforce(message(INVITE), linkViolation('DELETE'), OFF, effects, { ...options, now: 1000 + i });
    expect(effects.deleteMessage).toHaveBeenCalledTimes(5);
    expect(effects.issueWarning).toHaveBeenCalledOnce();
    expect(effects.notes).toHaveLength(1);
  });

  it('without admin rights: says so once, and falls back to warning', async () => {
    const effects = io({ botIsAdmin: async () => false });
    const options = throttles();
    expect(await enforce(message(INVITE), linkViolation('DELETE'), OFF, effects, options)).toBe('warned');
    expect(effects.deleteMessage).not.toHaveBeenCalled();
    expect(effects.notes[0]).toMatch(/not an admin/);

    await enforce(message(INVITE), linkViolation('DELETE'), OFF, effects, { ...options, now: Date.now() + 61_000 });
    expect(effects.notes.filter((note) => /not an admin/.test(note))).toHaveLength(1);
  });

  it('silence: deletes quietly, never warns', async () => {
    const effects = io();
    const silence: Violation = { rule: 'silence', action: 'DELETE', reason: 'you are silenced in this group' };
    expect(await enforce(message('hi'), silence, OFF, effects, throttles())).toBe('deleted');
    expect(effects.issueWarning).not.toHaveBeenCalled();
    expect(effects.notes).toHaveLength(0);
  });
});
