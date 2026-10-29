/**
 * WhatsApp connectivity (Baileys).
 *
 * This platform owns its own WhatsApp number and its own session. Auth state
 * is written to WHATSAPP_AUTH_DIR on this machine and never leaves it — no
 * third-party pairing site is involved, and no session string is pasted into
 * an environment variable, so the credentials to the account are only ever in
 * one place the operator controls.
 *
 * Reconnection is handled with backoff. A logged-out session is NOT retried:
 * that requires a human to pair again, and silently looping would just burn
 * attempts against WhatsApp.
 */
import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  toNumber,
  useMultiFileAuthState,
  WAMessageStubType,
  type GroupMetadata,
  type WAMessageKey,
  type WASocket,
  type proto,
} from '@whiskeysockets/baileys';
import { mkdir, rm } from 'node:fs/promises';
import qrcodeTerminal from 'qrcode-terminal';
import { env } from '../config/env.js';
import { TtlCache } from '../core/cache.js';
import { logger, redactJid } from '../core/logger.js';
import { handleMessage, type InboundMessage, type Transport } from '../commands/router.js';
import { moderateGroupMessage } from '../moderation/service.js';
import { findGroupSettings } from '../db/repositories/groups.js';
import { MAX_TAGGED, renderWelcome, WelcomeBatcher } from '../groups/welcome.js';
import { acquireSessionLock, releaseSessionLock } from './session-lock.js';
import {
  baseJid,
  type GroupActions,
  type GroupInfo,
  type GroupSetting,
  type ParticipantAction,
  type ParticipantResult,
} from './group.js';

const log = logger.child({ component: 'whatsapp' });

/** Baileys expects a pino-like logger; our instance satisfies it structurally. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const baileysLogger = logger.child({ component: 'baileys' }) as any;

export interface WhatsAppStatus {
  connected: boolean;
  /** Our own JID once connected. */
  selfJid: string | null;
  lastConnectedAt: Date | null;
  lastDisconnectReason: string | null;
  reconnectAttempts: number;
  /** Set while a pairing code is awaiting entry on the phone. */
  pairingCode: string | null;
  /**
   * The current QR payload, while one is awaiting a scan.
   *
   * Captured so it can be rendered in a browser. On a host with no terminal
   * — shared hosting, a container, a remote server — printing the QR to stdout
   * makes pairing impossible, which would otherwise rule out those platforms
   * entirely.
   *
   * It is a credential: anyone who scans it binds the bot to their account.
   * Only ever served over the token-guarded pairing endpoint.
   */
  qr: string | null;
  /** When the current QR was issued; they rotate roughly every 20 seconds. */
  qrIssuedAt: Date | null;
}

const status: WhatsAppStatus = {
  connected: false,
  selfJid: null,
  lastConnectedAt: null,
  lastDisconnectReason: null,
  reconnectAttempts: 0,
  pairingCode: null,
  qr: null,
  qrIssuedAt: null,
};

export function whatsappStatus(): Readonly<WhatsAppStatus> {
  return { ...status };
}

let socket: WASocket | null = null;
let shuttingDown = false;

/**
 * Ids of messages this process sent.
 *
 * The bot now processes its own outgoing messages, so the operator can drive it
 * from the very phone it is paired to. That makes a loop guard essential: an
 * echo of our own reply must never be re-handled as input.
 */
const recentlySent = new TtlCache<true>(5 * 60 * 1000, 1000);

/**
 * Automatic re-pairing after a logout.
 *
 * A logged-out session is already dead: WhatsApp has invalidated those
 * credentials and nothing can revive them. Deleting them and asking to pair
 * again is therefore the only recovery, and doing it automatically means the
 * bot comes back by itself instead of sitting dark until someone notices.
 *
 * It is capped so a repeatedly-rejected account cannot spin forever generating
 * pairing requests against WhatsApp.
 */
const MAX_REPAIR_ATTEMPTS = 3;
const REPAIR_WINDOW_MS = 60 * 60 * 1000;

let repairAttempts = 0;
let repairWindowStartedAt = 0;

function rememberSent(id: string | null | undefined): void {
  if (id) recentlySent.set(id, true);
}

/**
 * Who actually wrote the message.
 *
 * Prefers the phone-number JID that newer WhatsApp supplies alongside a LID
 * (`participantPn` / `senderPn`). Without this, members on LID-based accounts
 * get an identity that cannot be matched against ADMIN_NUMBERS, so admin
 * commands silently fail for people who really are administrators.
 */
function resolveSender(
  sock: WASocket,
  key: WAMessageKey,
  isGroup: boolean,
  chatJid: string,
): string {
  if (key.fromMe) {
    // We sent it, so the author is this account, not the chat partner.
    return sock.user?.id ? baseJid(sock.user.id) : '';
  }
  if (isGroup) return baseJid(key.participantPn ?? key.participant ?? '');
  return baseJid(key.senderPn ?? chatJid);
}

/**
 * The sender's anonymous id (`…@lid`), when the message carried one.
 *
 * Groups with privacy addressing list members only by LID, so the phone JID
 * from `resolveSender` alone cannot always be found in the member list.
 */
function resolveSenderLid(
  sock: WASocket,
  key: WAMessageKey,
  isGroup: boolean,
  chatJid: string,
): string | null {
  if (key.fromMe) return sock.user?.lid ? baseJid(sock.user.lid) : null;
  const candidates = isGroup
    ? [key.participantLid, key.participant]
    : [key.senderLid, chatJid];
  const lid = candidates.find((jid) => typeof jid === 'string' && jid.endsWith('@lid'));
  return lid ? baseJid(lid) : null;
}

/**
 * Pull displayable text out of a message.
 *
 * Captions count: a member forwarding a flyer with ".jobs" as the caption
 * clearly means to run the command.
 */
function extractText(message: proto.IWebMessageInfo): string | null {
  const content = message.message;
  if (!content) return null;

  const candidate =
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    content.buttonsResponseMessage?.selectedButtonId ??
    content.listResponseMessage?.singleSelectReply?.selectedRowId ??
    null;

  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : null;
}

/** WhatsApp's forwarding counter; 5 or more is shown as "forwarded many times". */
function extractForwardingScore(message: proto.IWebMessageInfo): number {
  const content = message.message;
  const contextInfo =
    content?.extendedTextMessage?.contextInfo ??
    content?.imageMessage?.contextInfo ??
    content?.videoMessage?.contextInfo ??
    content?.documentMessage?.contextInfo ??
    null;
  return contextInfo?.forwardingScore ?? 0;
}

/**
 * Is this something a member posted, as opposed to a reaction, receipt, edit or
 * key exchange? Only posts are moderated; deleting a protocol message would
 * fail or, worse, delete the wrong thing.
 */
function isPost(message: proto.IWebMessageInfo): boolean {
  const content = message.message;
  if (!content) return false;
  return Boolean(
    content.conversation ||
      content.extendedTextMessage ||
      content.imageMessage ||
      content.videoMessage ||
      content.audioMessage ||
      content.documentMessage ||
      content.documentWithCaptionMessage ||
      content.stickerMessage ||
      content.contactMessage ||
      content.contactsArrayMessage ||
      content.locationMessage ||
      content.liveLocationMessage ||
      content.pollCreationMessage ||
      content.pollCreationMessageV3,
  );
}

/**
 * JIDs the sender explicitly tagged.
 *
 * Group commands act on mentions, so this must come from the message's own
 * context info rather than being parsed out of the text: the visible "@2547..."
 * is only a label, and trusting it would let anyone forge a target.
 */
function extractMentions(message: proto.IWebMessageInfo): string[] {
  const content = message.message;
  if (!content) return [];

  const contextInfo =
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    null;

  const mentioned = contextInfo?.mentionedJid ?? [];
  return mentioned.filter((jid): jid is string => typeof jid === 'string').map(baseJid);
}

function toGroupInfo(metadata: GroupMetadata): GroupInfo {
  return {
    jid: metadata.id,
    subject: metadata.subject,
    description: metadata.desc ?? null,
    owner: metadata.owner ?? null,
    createdAt: metadata.creation ? new Date(metadata.creation * 1000) : null,
    participants: metadata.participants.map((participant) => ({
      jid: participant.id,
      phoneJid: participant.jid || null,
      lid: participant.lid || null,
      isAdmin: participant.admin === 'admin' || participant.admin === 'superadmin',
      isSuperAdmin: participant.admin === 'superadmin',
    })),
    announceOnly: Boolean(metadata.announce),
    locked: Boolean(metadata.restrict),
    communityJid: metadata.linkedParent ?? (metadata.isCommunity ? metadata.id : null),
  };
}

/**
 * Group metadata for moderation, which runs on every group message.
 *
 * Fetching it per message would hammer WhatsApp. Membership and admin changes
 * evict the entry (see the group events in `startWhatsApp`), so a promotion
 * takes effect at once rather than after the TTL.
 */
const groupInfoCache = new TtlCache<GroupInfo>(5 * 60_000, 500);

async function cachedGroupInfo(sock: WASocket, groupJid: string): Promise<GroupInfo> {
  const hit = groupInfoCache.get(groupJid);
  if (hit) return hit;
  const info = toGroupInfo(await sock.groupMetadata(groupJid));
  groupInfoCache.set(groupJid, info);
  return info;
}

/** Baileys-backed group administration. */
function buildGroupActions(sock: WASocket): GroupActions {
  return {
    async info(groupJid: string): Promise<GroupInfo> {
      const info = toGroupInfo(await sock.groupMetadata(groupJid));
      groupInfoCache.set(groupJid, info);
      return info;
    },

    async listGroups(): Promise<GroupInfo[]> {
      const all = await sock.groupFetchAllParticipating();
      return Object.values(all).map(toGroupInfo);
    },

    async updateParticipants(
      groupJid: string,
      participantJids: string[],
      action: ParticipantAction,
    ): Promise<ParticipantResult[]> {
      const raw = await sock.groupParticipantsUpdate(groupJid, participantJids, action);
      // Baileys returns a per-participant status; "200" is success. Reporting
      // each one matters because WhatsApp routinely refuses some and not others.
      return raw.map((entry) => ({
        jid: entry.jid ?? '',
        ok: String(entry.status) === '200',
        status: entry.status !== undefined ? String(entry.status) : undefined,
      }));
    },

    async updateSetting(groupJid: string, setting: GroupSetting): Promise<void> {
      await sock.groupSettingUpdate(groupJid, setting);
    },

    async inviteCode(groupJid: string): Promise<string> {
      const code = await sock.groupInviteCode(groupJid);
      if (!code) throw new Error('WhatsApp did not return an invite code');
      return code;
    },
  };
}

function buildTransport(sock: WASocket): Transport {
  return {
    async sendText(chatJid, text, options) {
      const sent = await sock.sendMessage(chatJid, {
        text,
        ...(options?.mentions && options.mentions.length > 0
          ? { mentions: options.mentions }
          : {}),
      });
      rememberSent(sent?.key?.id);
    },
    async react(chatJid, emoji) {
      // Reactions need the key of the message being reacted to; without one we
      // skip silently rather than fail a command over a decoration.
      void chatJid;
      void emoji;
    },
    group: buildGroupActions(sock),
    selfJid: sock.user?.id ? baseJid(sock.user.id) : null,
    selfLid: sock.user?.lid ? baseJid(sock.user.lid) : null,
  };
}

/** Transport that can react to the specific message that triggered a command. */
function buildTransportFor(sock: WASocket, key: proto.IMessageKey): Transport {
  return {
    async sendText(chatJid, text, options) {
      const sent = await sock.sendMessage(chatJid, {
        text,
        ...(options?.mentions && options.mentions.length > 0
          ? { mentions: options.mentions }
          : {}),
      });
      rememberSent(sent?.key?.id);
    },
    async react(chatJid, emoji) {
      try {
        const sent = await sock.sendMessage(chatJid, { react: { text: emoji, key } });
        rememberSent(sent?.key?.id);
      } catch (cause) {
        log.debug({ err: String(cause) }, 'reaction failed (ignored)');
      }
    },
    group: buildGroupActions(sock),
    selfJid: sock.user?.id ? baseJid(sock.user.id) : null,
    selfLid: sock.user?.lid ? baseJid(sock.user.lid) : null,
  };
}

export async function startWhatsApp(): Promise<void> {
  await mkdir(env.WHATSAPP_AUTH_DIR, { recursive: true });
  // Throws if another live process already owns this session. Refusing to
  // start is far better than silently corrupting the encryption state.
  acquireSessionLock(env.WHATSAPP_AUTH_DIR);
  await connect();
}

async function connect(): Promise<void> {
  if (shuttingDown) return;

  const { state, saveCreds } = await useMultiFileAuthState(env.WHATSAPP_AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  log.info({ version: version.join('.'), isLatest }, 'using WhatsApp web version');

  const sock = makeWASocket({
    version,
    logger: baileysLogger,
    // We drive pairing explicitly below so the code can also be surfaced over
    // HTTP, rather than only being printable in a terminal.
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    browser: ['PHC Platform', 'Chrome', '1.0.0'],
    // Receipts and presence left at defaults: this is an assistant, not a
    // surveillance tool, and it should not mark a member's messages read in
    // ways they did not ask for.
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  socket = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && env.WHATSAPP_PAIR_NUMBER === '') {
      // Kept in memory for the browser pairing page as well as the terminal.
      status.qr = qr;
      status.qrIssuedAt = new Date();
      log.info(
        env.PAIRING_PAGE === 'on'
          ? 'scan the QR code below, or open the pairing page in a browser'
          : 'scan the QR code below with WhatsApp > Linked devices > Link a device',
      );
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'open') {
      status.connected = true;
      status.selfJid = sock.user?.id ?? null;
      status.lastConnectedAt = new Date();
      status.lastDisconnectReason = null;
      status.reconnectAttempts = 0;
      status.pairingCode = null;
      // The QR is spent once connected; holding it would serve a stale
      // credential to the pairing page.
      status.qr = null;
      status.qrIssuedAt = null;
      repairAttempts = 0;
      log.info({ self: redactJid(sock.user?.id) }, 'WhatsApp connected');
      return;
    }

    if (connection === 'close') {
      status.connected = false;
      const boom = lastDisconnect?.error instanceof Boom ? lastDisconnect.error : undefined;
      const statusCode = boom?.output?.statusCode;
      status.lastDisconnectReason = boom?.message ?? 'unknown';

      if (statusCode === DisconnectReason.loggedOut) {
        // The stored credentials are dead. Clear them and ask to pair again.
        void repairSession();
        return;
      }

      void scheduleReconnect();
    }
  });

  // Pairing-code flow: requested once, after the socket exists but before creds
  // are registered.
  if (env.WHATSAPP_PAIR_NUMBER !== '' && !sock.authState.creds.registered) {
    // Baileys needs a moment before it will accept a pairing request.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const code = await sock.requestPairingCode(env.WHATSAPP_PAIR_NUMBER);
      status.pairingCode = code;
      log.info({ code }, 'enter this pairing code in WhatsApp > Linked devices > Link with phone number');
    } catch (cause) {
      log.error({ err: cause instanceof Error ? cause.message : String(cause) }, 'pairing request failed');
    }
  }

  // Promotions, removals and settings changes make cached metadata stale.
  sock.ev.on('group-participants.update', ({ id }) => groupInfoCache.delete(id));
  sock.ev.on('groups.update', (updates) => {
    for (const update of updates) if (update.id) groupInfoCache.delete(update.id);
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Join notices are checked whatever the type; each carries its own
    // timestamp, so a stale one is recognised and skipped.
    for (const message of messages) noteJoin(sock, message);

    // "append" carries history sync and our own sends; only react to new traffic.
    if (type !== 'notify') return;

    for (const message of messages) {
      try {
        await onMessage(sock, message);
      } catch (cause) {
        log.error({ err: cause instanceof Error ? cause.stack : String(cause) }, 'message handling failed');
      }
    }
  });
}

async function onMessage(sock: WASocket, message: proto.IWebMessageInfo): Promise<void> {
  const key = message.key as WAMessageKey;
  const chatJid = key.remoteJid;
  if (!chatJid || chatJid === 'status@broadcast') return;

  // Never re-handle an echo of something we just sent, which would loop.
  if (key.id && recentlySent.get(key.id)) return;

  const text = extractText(message);
  const isGroup = chatJid.endsWith('@g.us');

  // Before command handling, so a silenced member cannot run commands either,
  // and for media too, which has no text. Never for our own messages.
  if (isGroup && !key.fromMe && isPost(message)) {
    const moderated = await moderate(sock, message, key, chatJid, text ?? '').catch((cause) => {
      // Fail open: a moderation fault must never take commands down with it.
      log.warn({ err: cause instanceof Error ? cause.message : String(cause) }, 'moderation failed');
      return false;
    });
    if (moderated) return;
  }

  if (!text) return;

  const senderJid = resolveSender(sock, key, isGroup, chatJid);
  if (senderJid.length === 0) return;

  // Logged at debug so a silent bot can be diagnosed without turning on
  // verbose Baileys output. Never logs the message text.
  log.debug(
    { chat: redactJid(chatJid), sender: redactJid(senderJid), isGroup, fromMe: Boolean(key.fromMe) },
    'inbound message',
  );

  const inbound: InboundMessage = {
    chatJid,
    senderJid,
    senderLid: resolveSenderLid(sock, key, isGroup, chatJid),
    isGroup,
    text,
    mentionedJids: extractMentions(message),
  };
  await handleMessage(inbound, buildTransportFor(sock, key));
}

// ── Welcomes ────────────────────────────────────────────────────────────────

/** Stub messages WhatsApp posts in a group when someone joins it, however they joined. */
const JOIN_STUBS = new Set<number>([
  WAMessageStubType.GROUP_PARTICIPANT_ADD,
  WAMessageStubType.GROUP_PARTICIPANT_INVITE,
  WAMessageStubType.GROUP_PARTICIPANT_ADD_REQUEST_JOIN,
  WAMessageStubType.GROUP_PARTICIPANT_ACCEPT,
  WAMessageStubType.GROUP_PARTICIPANT_LINKED_GROUP_JOIN,
]);

/** Joins older than this are not welcomed: they arrived while the bot was offline. */
const WELCOME_MAX_AGE_MS = 10 * 60_000;

const welcomedStubs = new TtlCache<true>(60 * 60_000, 2000);

const welcomeBatcher = new WelcomeBatcher(
  (groupJid, participants) => sendWelcome(groupJid, participants),
  undefined,
  (cause) => log.warn({ err: cause instanceof Error ? cause.message : String(cause) }, 'welcome failed'),
);

/** The JIDs in a join stub. Plain JIDs today; JSON objects in newer WhatsApp builds. */
function joinedJids(parameters: string[]): string[] {
  const jids: string[] = [];
  for (const parameter of parameters) {
    if (!parameter.startsWith('{')) {
      if (parameter.includes('@')) jids.push(baseJid(parameter));
      continue;
    }
    try {
      const parsed = JSON.parse(parameter) as Record<string, unknown>;
      const id = [parsed.id, parsed.lid, parsed.phoneNumber].find(
        (value): value is string => typeof value === 'string' && value.includes('@'),
      );
      if (id) jids.push(baseJid(id));
    } catch {
      // Not a participant: ignore.
    }
  }
  return jids;
}

/** Queue a welcome when this message is WhatsApp's "X joined" notice. */
function noteJoin(sock: WASocket, message: proto.IWebMessageInfo): void {
  const stub = message.messageStubType;
  const groupJid = message.key?.remoteJid;
  if (stub === null || stub === undefined || !JOIN_STUBS.has(stub)) return;
  if (!groupJid?.endsWith('@g.us')) return;

  const id = message.key?.id;
  if (id) {
    if (welcomedStubs.get(id)) return;
    welcomedStubs.set(id, true);
  }

  const sentAt = toNumber(message.messageTimestamp) * 1000;
  if (sentAt > 0 && Date.now() - sentAt > WELCOME_MAX_AGE_MS) return;

  const selfIds = [sock.user?.id, sock.user?.lid]
    .filter((jid): jid is string => typeof jid === 'string' && jid.length > 0)
    .map(baseJid);
  const joined = joinedJids(message.messageStubParameters ?? []).filter((jid) => !selfIds.includes(jid));
  welcomeBatcher.add(groupJid, joined);
}

async function sendWelcome(groupJid: string, participants: string[]): Promise<void> {
  const sock = socket;
  if (!sock || !status.connected) return;

  const settings = await findGroupSettings(groupJid);
  if (!settings?.welcomeEnabled) return;

  let subject = 'the group';
  try {
    subject = (await cachedGroupInfo(sock, groupJid)).subject;
  } catch {
    // The welcome still works without the group's name.
  }

  const tagged = participants.slice(0, MAX_TAGGED);
  const text = renderWelcome(settings.welcomeMessage, {
    tags: tagged.map((jid) => `@${jid.split('@')[0] ?? ''}`),
    others: participants.length - tagged.length,
    group: subject,
  });
  const sent = await sock.sendMessage(groupJid, { text, mentions: tagged });
  rememberSent(sent?.key?.id);
  log.info({ group: redactJid(groupJid), joined: participants.length }, 'welcomed new members');
}

// ── Moderation ──────────────────────────────────────────────────────────────

async function moderate(
  sock: WASocket,
  message: proto.IWebMessageInfo,
  key: WAMessageKey,
  groupJid: string,
  text: string,
): Promise<boolean> {
  const senderJid = resolveSender(sock, key, true, groupJid);
  if (senderJid.length === 0) return false;
  // The id this group knows the sender by: mentions and removals must use it.
  const authorJid = key.participant ? baseJid(key.participant) : senderJid;
  const selfIds = [sock.user?.id, sock.user?.lid]
    .filter((jid): jid is string => typeof jid === 'string' && jid.length > 0)
    .map(baseJid);

  return moderateGroupMessage(
    {
      groupJid,
      senderJid,
      senderLid: resolveSenderLid(sock, key, true, groupJid),
      text,
      forwardingScore: extractForwardingScore(message),
    },
    {
      groupInfo: () => cachedGroupInfo(sock, groupJid),
      selfIds,
      async deleteMessage() {
        const sent = await sock.sendMessage(groupJid, { delete: key });
        rememberSent(sent?.key?.id);
      },
      async removeSender() {
        const [result] = await sock.groupParticipantsUpdate(groupJid, [authorJid], 'remove');
        groupInfoCache.delete(groupJid);
        return String(result?.status) === '200';
      },
      async notify(template) {
        const tag = `@${authorJid.split('@')[0] ?? ''}`;
        const sent = await sock.sendMessage(groupJid, {
          text: template.replaceAll('{sender}', tag),
          mentions: [authorJid],
        });
        rememberSent(sent?.key?.id);
      },
    },
  );
}

/**
 * Recover from a logout: discard the dead credentials and start pairing again.
 *
 * Safe to delete the auth directory here precisely because the session is
 * already invalid — there is nothing to lose, and keeping it would only make
 * every reconnect fail the same way.
 */
export async function repairSession(): Promise<void> {
  if (shuttingDown) return;

  const now = Date.now();
  if (now - repairWindowStartedAt > REPAIR_WINDOW_MS) {
    repairWindowStartedAt = now;
    repairAttempts = 0;
  }
  repairAttempts += 1;

  if (repairAttempts > MAX_REPAIR_ATTEMPTS) {
    log.error(
      { attempts: repairAttempts - 1 },
      'WhatsApp logged out repeatedly; stopping automatic re-pairing. ' +
        'Check the account is not being unlinked from the phone, then restart the service.',
    );
    return;
  }

  log.warn(
    { attempt: repairAttempts, max: MAX_REPAIR_ATTEMPTS },
    'WhatsApp session logged out — clearing stored credentials and requesting a new pairing',
  );

  try {
    await rm(env.WHATSAPP_AUTH_DIR, { recursive: true, force: true });
    await mkdir(env.WHATSAPP_AUTH_DIR, { recursive: true });
    // Clearing the directory removed our lock file along with it.
    acquireSessionLock(env.WHATSAPP_AUTH_DIR);
  } catch (cause) {
    log.error(
      { err: cause instanceof Error ? cause.message : String(cause), dir: env.WHATSAPP_AUTH_DIR },
      'could not clear the auth directory; pair manually after deleting it',
    );
    return;
  }

  status.pairingCode = null;
  status.selfJid = null;
  status.qr = null;
  status.qrIssuedAt = null;
  // Short pause so WhatsApp does not see an instant reconnect.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  try {
    await connect();
    log.info('pairing restarted — scan the QR code or enter the pairing code shown above');
  } catch (cause) {
    log.error({ err: cause instanceof Error ? cause.message : String(cause) }, 're-pairing failed');
    void scheduleReconnect();
  }
}

/** Reconnect with capped exponential backoff. */
async function scheduleReconnect(): Promise<void> {
  if (shuttingDown) return;

  status.reconnectAttempts += 1;
  const attempt = status.reconnectAttempts;
  const delayMs = Math.min(60_000, 2000 * 2 ** Math.min(attempt - 1, 5));

  log.warn({ attempt, delayMs, reason: status.lastDisconnectReason }, 'reconnecting to WhatsApp');
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  try {
    await connect();
  } catch (cause) {
    log.error({ err: cause instanceof Error ? cause.message : String(cause) }, 'reconnect failed');
    void scheduleReconnect();
  }
}

/** Expose a transport for scheduled jobs (digests, deadline alerts). */
export function currentTransport(): Transport | null {
  return socket ? buildTransport(socket) : null;
}

export async function stopWhatsApp(): Promise<void> {
  shuttingDown = true;
  welcomeBatcher.clear();
  if (!socket) return;
  try {
    // `end` rather than `logout`: we are shutting the process down, not
    // unlinking the device, which would force a human to pair again.
    socket.end(undefined);
    log.info('WhatsApp connection closed');
  } catch (cause) {
    log.warn({ err: String(cause) }, 'error while closing WhatsApp connection');
  } finally {
    socket = null;
    status.connected = false;
    releaseSessionLock(env.WHATSAPP_AUTH_DIR);
  }
}
