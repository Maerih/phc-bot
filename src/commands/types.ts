/**
 * Command contract.
 *
 * A command is one file exporting one `Command`. It receives a context and
 * replies through it; it never touches the WhatsApp socket directly. That
 * keeps commands unit-testable without a WhatsApp connection and lets the same
 * handlers back a future HTTP or dashboard surface.
 */
import type { Logger } from '../core/logger.js';
import type { GroupActions } from '../whatsapp/group.js';
import type { MemberRow } from '../db/schema.js';
import type { ScoredOpportunity } from '../search/rank.js';
import type { SearchQuery } from '../sources/types.js';

export type CommandCategory =
  | 'system'
  | 'jobs'
  | 'scholarships'
  | 'internships'
  | 'fellowships'
  | 'research'
  | 'events'
  | 'news'
  | 'members'
  | 'group'
  | 'admin'
  | 'ai';

/** Per-member conversational state, used for pagination and `.details <n>`. */
export interface MemberSession {
  query: SearchQuery;
  /** The command that produced the current page, for accurate hints. */
  command: string;
  /** The page currently shown, so `.save 2` resolves to the right entry. */
  page: ScoredOpportunity[];
  totalMatched: number;
  createdAt: number;
}

export interface ReplyOptions {
  /** JIDs to tag. WhatsApp only renders a mention if the JID is listed here. */
  mentions?: string[];
}

export interface CommandContext {
  /** Chat the message arrived in — a group JID or a direct JID. */
  chatJid: string;
  /** The individual who sent it. In a group this differs from `chatJid`. */
  senderJid: string;
  /** The sender's anonymous id (`…@lid`), when known. Groups may list only this. */
  senderLid: string | null;
  isGroup: boolean;

  /** JIDs explicitly mentioned in the message, already normalised. */
  mentionedJids: string[];
  /** The bot's own JID, when connected. Used to avoid acting on itself. */
  selfJid: string | null;
  /** The bot's own anonymous id (`…@lid`), when known. */
  selfLid: string | null;
  /** Group administration, when the transport supports it. */
  group: GroupActions | null;

  /** Everything after the command word, trimmed. */
  args: string;
  /** `args` split on whitespace, empty entries removed. */
  argv: string[];
  /** The command word as typed, without the prefix. */
  invokedAs: string;

  member: MemberRow;
  /** True only for numbers in ADMIN_NUMBERS. Never inferred from the message. */
  isAdmin: boolean;

  log: Logger;

  /** Send a reply to the originating chat. */
  reply(text: string, options?: ReplyOptions): Promise<void>;
  /** Signal that work is in progress, for searches that take a moment. */
  react(emoji: string): Promise<void>;

  getSession(): MemberSession | undefined;
  setSession(session: MemberSession): void;
  clearSession(): void;
}

export interface Command {
  /** Primary name, without the prefix. */
  name: string;
  aliases?: string[];
  category: CommandCategory;
  /** One line for `.help`. */
  summary: string;
  /** Usage string, e.g. "`.job <keywords>`". */
  usage: string;
  examples?: string[];
  /** Admin-only commands are authorised against ADMIN_NUMBERS, not the name. */
  adminOnly?: boolean;
  /** Skip the rate limiter — only for trivial, non-fanning-out commands. */
  exemptFromRateLimit?: boolean;
  handler(context: CommandContext): Promise<void>;
}
