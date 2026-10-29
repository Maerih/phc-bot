/**
 * Group administration capability.
 *
 * Commands never touch the WhatsApp socket directly, so group operations are
 * exposed through this interface. The Baileys implementation lives alongside
 * the client; a fake implementation makes every group command unit-testable
 * with no connection.
 */

export interface GroupParticipant {
  /** The id WhatsApp lists the member under: a phone JID, or a LID. */
  jid: string;
  /** Phone-number JID, when WhatsApp disclosed it. */
  phoneJid?: string | null;
  /** Anonymous id (`…@lid`), when the group uses or disclosed one. */
  lid?: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface GroupInfo {
  jid: string;
  subject: string;
  description: string | null;
  owner: string | null;
  createdAt: Date | null;
  participants: GroupParticipant[];
  /** Only admins may send messages. */
  announceOnly: boolean;
  /** Only admins may edit group info. */
  locked: boolean;
  /** The community this group belongs to (or is), when it is part of one. */
  communityJid?: string | null;
}

export type ParticipantAction = 'add' | 'remove' | 'promote' | 'demote';
export type GroupSetting = 'announcement' | 'not_announcement' | 'locked' | 'unlocked';

/** Per-participant outcome, because WhatsApp fails these individually. */
export interface ParticipantResult {
  jid: string;
  ok: boolean;
  /** WhatsApp's numeric status, when it supplied one. */
  status?: string;
  reason?: string;
}

export interface GroupActions {
  info(groupJid: string): Promise<GroupInfo>;
  /** Every group the bot is in, with full metadata. */
  listGroups(): Promise<GroupInfo[]>;
  updateParticipants(
    groupJid: string,
    participantJids: string[],
    action: ParticipantAction,
  ): Promise<ParticipantResult[]>;
  updateSetting(groupJid: string, setting: GroupSetting): Promise<void>;
  inviteCode(groupJid: string): Promise<string>;
}

/**
 * Translate WhatsApp's participant-update status codes into something a member
 * can act on. Returning the raw code would be useless to an administrator.
 */
export function describeParticipantFailure(status: string | undefined, action: ParticipantAction): string {
  switch (status) {
    case '403':
      return 'their privacy settings do not allow being added';
    case '408':
      return 'they recently left and cannot be re-added yet';
    case '401':
      return 'they blocked this bot';
    case '404':
      return 'that number is not on WhatsApp';
    case '409':
      return action === 'add' ? 'they are already in the group' : 'no change was needed';
    case '500':
      return 'the group is full';
    default:
      return status ? `WhatsApp returned status ${status}` : 'WhatsApp rejected the request';
  }
}

/** Normalise a typed phone number into a WhatsApp JID. */
export function toUserJid(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  // Shorter than 6 digits cannot be a routable international number.
  if (digits.length < 6 || digits.length > 20) return null;
  return `${digits}@s.whatsapp.net`;
}

/** Strip the device suffix so two JIDs for one person compare equal. */
export function baseJid(jid: string): string {
  const [user = '', domain = ''] = jid.split('@');
  return `${user.split(':')[0]}@${domain}`;
}

/**
 * The participant known by any of the given identities.
 *
 * One person can have two ids: groups with privacy addressing list members
 * by LID (`…@lid`), while senders, typed numbers and the bot's own id arrive
 * as phone JIDs. Matching only one form misidentifies people — including the
 * bot itself, which then believes it is not an admin of its own group.
 */
export function findParticipant(
  info: GroupInfo,
  ...jids: Array<string | null | undefined>
): GroupParticipant | undefined {
  const wanted = new Set(
    jids.filter((jid): jid is string => typeof jid === 'string' && jid.length > 0).map(baseJid),
  );
  if (wanted.size === 0) return undefined;
  return info.participants.find((participant) =>
    [participant.jid, participant.phoneJid, participant.lid].some(
      (id) => typeof id === 'string' && id.length > 0 && wanted.has(baseJid(id)),
    ),
  );
}

/** Is the person known by any of these ids an admin of the group? */
export function isGroupAdmin(info: GroupInfo, ...jids: Array<string | null | undefined>): boolean {
  const participant = findParticipant(info, ...jids);
  return participant !== undefined && (participant.isAdmin || participant.isSuperAdmin);
}

/**
 * Mentioned JIDs, from an explicit mention list or from numbers typed inline.
 *
 * Supporting both matters in practice: administrators often type a number
 * rather than tapping a mention, and a command that silently does nothing is
 * worse than one that says what it could not parse.
 */
export function resolveTargets(mentioned: string[], argv: string[]): string[] {
  if (mentioned.length > 0) return Array.from(new Set(mentioned.map(baseJid)));

  const fromArgs = argv
    .map((token) => toUserJid(token))
    .filter((jid): jid is string => jid !== null);

  return Array.from(new Set(fromArgs));
}
