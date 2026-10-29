import { describe, expect, it } from 'vitest';
import {
  assessPromotion,
  findBannedWord,
  findLinks,
  fingerprint,
  normaliseDomain,
  PROMO_REVIEW_THRESHOLD,
  PROMO_THRESHOLD,
} from './detect.js';

describe('findLinks', () => {
  it('treats WhatsApp group and channel links as invites', () => {
    const found = findLinks('Join us https://chat.whatsapp.com/AbCdEf123 and whatsapp.com/channel/0029Va');
    expect(found.invites).toHaveLength(2);
    expect(found.external).toHaveLength(0);
  });

  it('treats wa.me and Telegram as invites, even without a scheme', () => {
    expect(findLinks('chat me wa.me/254712345678').invites).toHaveLength(1);
    expect(findLinks('t.me/cheapdeals').invites).toHaveLength(1);
  });

  it('keeps ordinary links separate from invites', () => {
    const found = findLinks('Apply at https://www.who.int/careers/fellowship-2027 before Friday');
    expect(found.invites).toHaveLength(0);
    expect(found.external).toEqual(['https://www.who.int/careers/fellowship-2027']);
  });

  it('drops allowed domains and their subdomains', () => {
    const found = findLinks('https://careers.who.int/x and kemri.go.ke/jobs', ['who.int', 'kemri.go.ke']);
    expect(found.external).toHaveLength(0);
  });

  it('does not mistake abbreviations for links', () => {
    expect(findLinks('e.g. a Ph.D. or M.Sc. in epidemiology, i.e. 3 yrs')).toEqual({ invites: [], external: [] });
  });

  it('does not treat whatsapp.com help pages as invites', () => {
    expect(findLinks('see https://faq.whatsapp.com/123').invites).toHaveLength(0);
  });
});

describe('normaliseDomain', () => {
  it('reduces a pasted URL to its domain', () => {
    expect(normaliseDomain('https://www.Who.int/careers')).toBe('who.int');
    expect(normaliseDomain('kemri.go.ke')).toBe('kemri.go.ke');
  });

  it('rejects things that are not domains', () => {
    expect(normaliseDomain('hello')).toBeNull();
    expect(normaliseDomain('')).toBeNull();
  });
});

describe('assessPromotion', () => {
  const adverts = [
    '🔥🔥 MEGA OFFER!! Original sneakers now Ksh 2,500 only. Free delivery within Nairobi. DM me or call 0712345678',
    'Earn KSh 5,000 daily from your phone! No experience needed. Join here: https://bit.ly/xyz',
    'Hello everyone, I sell affordable laptops. Inbox me for prices',
    'Forex trading signals with 95% accuracy, join our VIP channel t.me/fxwins',
    'Instant loans available in 5 minutes, no CRB check. Call/WhatsApp 0798765432',
    'Grow your followers fast! Buy 1000 Instagram followers for $5. Link in bio',
  ];

  for (const advert of adverts) {
    it(`flags: ${advert.slice(0, 50)}…`, () => {
      expect(assessPromotion(advert).score).toBeGreaterThanOrEqual(PROMO_THRESHOLD);
    });
  }

  const genuine = [
    'WHO Fellowship 2027 — applications open. Deadline 15 Nov. Apply: https://who.int/careers/fellowship',
    'Research assistant vacancy at KEMRI, stipend KES 40,000 per month. Apply by 30 Nov: https://kemri.go.ke/jobs',
    'Free webinar on antimicrobial resistance this Thursday 6pm EAT. Register: https://example.org/amr',
    'Has anyone done the MPH at Moi University? How was the programme?',
    'Affordable healthcare is a human right — great article on UHC financing in Kenya.',
    'Masters scholarship for African students, fully funded, deadline 1 December. Details: daad.de',
  ];

  for (const post of genuine) {
    it(`leaves alone: ${post.slice(0, 50)}…`, () => {
      expect(assessPromotion(post).score).toBeLessThan(PROMO_REVIEW_THRESHOLD);
    });
  }

  it('explains its score without quoting the message', () => {
    const { reasons } = assessPromotion('DM me for cheap phones, Ksh 3000');
    expect(reasons).toContain('asks for private contact');
    expect(reasons).toContain('mentions a price');
  });

  it('nudges, but does not convict, on "forwarded many times"', () => {
    const text = 'Great tips on staying healthy this season';
    expect(assessPromotion(text, { forwardingScore: 8 }).score).toBe(assessPromotion(text).score + 1);
  });
});

describe('findBannedWord', () => {
  const words = ['crypto', 'fixed matches', 'ass'];

  it('matches whole words, case-insensitively', () => {
    expect(findBannedWord('Best CRYPTO deals here', words)).toBe('crypto');
  });

  it('never matches inside a longer word', () => {
    expect(findBannedWord('Applied cryptography and class notes', words)).toBeNull();
  });

  it('matches phrases with any spacing', () => {
    expect(findBannedWord('100% fixed   matches today', words)).toBe('fixed matches');
  });

  it('catches separated and look-alike spellings', () => {
    expect(findBannedWord('get c.r.y.p.t.o now', words)).toBe('crypto');
    expect(findBannedWord('cr7pt0 signals', ['crypto'])).toBeNull(); // 7 is t, not y
    expect(findBannedWord('cryp7o signals', words)).toBe('crypto');
  });

  it('returns null with nothing banned', () => {
    expect(findBannedWord('anything at all', [])).toBeNull();
  });
});

describe('fingerprint', () => {
  it('ignores case, spacing, punctuation and emoji', () => {
    expect(fingerprint('Cheap LOANS available now!!! 🔥')).toBe(fingerprint('cheap loans   available now'));
  });

  it('skips short messages that repeat innocently', () => {
    expect(fingerprint('Thank you!')).toBeNull();
    expect(fingerprint('Amen 🙏')).toBeNull();
  });
});
