import { describe, expect, it } from 'vitest';
import {
  baseJid,
  describeParticipantFailure,
  findParticipant,
  isGroupAdmin,
  resolveTargets,
  toUserJid,
  type GroupInfo,
} from './group.js';

function groupWith(participants: Array<[string, boolean]>): GroupInfo {
  return {
    jid: 'group@g.us',
    subject: 'Test',
    description: null,
    owner: null,
    createdAt: null,
    announceOnly: false,
    locked: false,
    participants: participants.map(([jid, isAdmin]) => ({
      jid,
      isAdmin,
      isSuperAdmin: false,
    })),
  };
}

describe('baseJid', () => {
  it('strips the multi-device suffix', () => {
    // Two JIDs for the same person must compare equal, or an admin check fails
    // for someone who is genuinely an admin.
    expect(baseJid('254712345678:12@s.whatsapp.net')).toBe('254712345678@s.whatsapp.net');
  });

  it('leaves a plain jid unchanged', () => {
    expect(baseJid('254712345678@s.whatsapp.net')).toBe('254712345678@s.whatsapp.net');
  });
});

describe('toUserJid', () => {
  it('normalises a typed number', () => {
    expect(toUserJid('254712345678')).toBe('254712345678@s.whatsapp.net');
    expect(toUserJid('+254 712 345 678')).toBe('254712345678@s.whatsapp.net');
  });

  it('rejects values that cannot be a routable number', () => {
    expect(toUserJid('123')).toBeNull();
    expect(toUserJid('')).toBeNull();
    expect(toUserJid('not a number')).toBeNull();
  });
});

describe('isGroupAdmin', () => {
  const info = groupWith([
    ['254700000001@s.whatsapp.net', true],
    ['254700000002@s.whatsapp.net', false],
  ]);

  it('recognises an admin', () => {
    expect(isGroupAdmin(info, '254700000001@s.whatsapp.net')).toBe(true);
  });

  it('recognises a non-admin', () => {
    expect(isGroupAdmin(info, '254700000002@s.whatsapp.net')).toBe(false);
  });

  it('recognises an admin whose jid carries a device suffix', () => {
    expect(isGroupAdmin(info, '254700000001:7@s.whatsapp.net')).toBe(true);
  });

  it('returns false for someone not in the group', () => {
    expect(isGroupAdmin(info, '254700000099@s.whatsapp.net')).toBe(false);
  });
});

describe('isGroupAdmin in a group that lists members by LID', () => {
  // How WhatsApp describes a privacy-addressed group: each member's id is a
  // LID, and the phone number is disclosed only for some members.
  const info: GroupInfo = {
    ...groupWith([]),
    participants: [
      {
        jid: '111111111111111@lid',
        phoneJid: '254700000001@s.whatsapp.net',
        lid: '111111111111111@lid',
        isAdmin: false,
        isSuperAdmin: true,
      },
      { jid: '222222222222222@lid', phoneJid: null, lid: '222222222222222@lid', isAdmin: true, isSuperAdmin: false },
      { jid: '333333333333333@lid', phoneJid: null, lid: '333333333333333@lid', isAdmin: false, isSuperAdmin: false },
    ],
  };

  it('finds an admin by phone number when WhatsApp disclosed it', () => {
    expect(isGroupAdmin(info, '254700000001:12@s.whatsapp.net')).toBe(true);
  });

  it('finds the bot by its LID when its phone number is not listed', () => {
    // The reported bug: the bot checked only its phone JID, so in this group
    // it never found itself and asked to be promoted while already an admin.
    expect(isGroupAdmin(info, '254700000002@s.whatsapp.net')).toBe(false);
    expect(isGroupAdmin(info, '254700000002@s.whatsapp.net', '222222222222222:3@lid')).toBe(true);
  });

  it('still reports a member who is not an admin', () => {
    expect(isGroupAdmin(info, null, '333333333333333@lid')).toBe(false);
  });

  it('ignores missing identities', () => {
    expect(isGroupAdmin(info, null, undefined, '')).toBe(false);
    expect(findParticipant(info)).toBeUndefined();
  });

  it('resolves both ids of one member to the same participant', () => {
    expect(findParticipant(info, '254700000001@s.whatsapp.net')).toBe(
      findParticipant(info, '111111111111111@lid'),
    );
  });
});

describe('resolveTargets', () => {
  it('prefers explicit mentions over typed text', () => {
    // Mentions come from the message's context info and cannot be forged by
    // typing an @-looking string, so they win.
    const targets = resolveTargets(['254700000001@s.whatsapp.net'], ['254700000099']);
    expect(targets).toEqual(['254700000001@s.whatsapp.net']);
  });

  it('falls back to typed numbers when nothing was mentioned', () => {
    expect(resolveTargets([], ['254712345678'])).toEqual(['254712345678@s.whatsapp.net']);
  });

  it('ignores argument tokens that are not numbers', () => {
    expect(resolveTargets([], ['spamming', 'repeatedly'])).toEqual([]);
  });

  it('de-duplicates', () => {
    expect(resolveTargets([], ['254712345678', '+254712345678'])).toHaveLength(1);
  });

  it('returns an empty list when there is nothing to act on', () => {
    expect(resolveTargets([], [])).toEqual([]);
  });
});

describe('describeParticipantFailure', () => {
  it('explains the common refusals in plain language', () => {
    expect(describeParticipantFailure('403', 'add')).toMatch(/privacy settings/);
    expect(describeParticipantFailure('408', 'add')).toMatch(/recently left/);
    expect(describeParticipantFailure('404', 'add')).toMatch(/not on WhatsApp/);
  });

  it('falls back to the raw status when unrecognised', () => {
    expect(describeParticipantFailure('999', 'remove')).toContain('999');
  });

  it('handles a missing status', () => {
    expect(describeParticipantFailure(undefined, 'promote')).toMatch(/rejected/);
  });
});
