/**
 * Welcome messages for people who join a group.
 *
 * Joins are batched per group: when a link is shared and twenty people join
 * in a minute, the group gets one welcome tagging them all, not twenty
 * messages from the bot burying the conversation.
 */

/** Used when a group turned welcomes on without writing its own message. */
export const DEFAULT_WELCOME = [
  'Welcome to *{group}*, {name}! 👋',
  '',
  'This community shares public-health jobs, scholarships, fellowships, training and events.',
  'Send `.menu` to see what I can find for you, and please keep posts on topic.',
].join('\n');

/** More newcomers than this are summarised as "and N others". */
export const MAX_TAGGED = 20;

/** "@a", "@a and @b", "@a, @b and @c", "@a, @b and 12 others". */
export function joinNames(tags: string[], others = 0): string {
  const parts = [...tags];
  if (others > 0) parts.push(`${others} other${others === 1 ? '' : 's'}`);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The welcome text. `{name}` becomes the newcomers' tags and `{group}` the
 * group's name. A custom message without `{name}` still tags them, on the
 * first line, so a welcome always reaches the people it is for.
 */
export function renderWelcome(
  template: string | null,
  options: { tags: string[]; others?: number; group: string },
): string {
  const body = template && template.trim().length > 0 ? template : DEFAULT_WELCOME;
  const names = joinNames(options.tags, options.others ?? 0);
  const rendered = body.replaceAll('{group}', options.group);
  return rendered.includes('{name}') ? rendered.replaceAll('{name}', names) : `${names}\n\n${rendered}`;
}

export interface WelcomeBatcherOptions {
  /** How long to gather joins before welcoming them together. */
  windowMs: number;
  /** At least this long between two welcomes in one group. */
  minGapMs: number;
}

export const DEFAULT_WELCOME_TIMING: WelcomeBatcherOptions = { windowMs: 5_000, minGapMs: 60_000 };

/** Gathers joins per group and hands each batch to `send` once. */
export class WelcomeBatcher {
  private readonly pending = new Map<string, Set<string>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    private readonly send: (groupJid: string, participants: string[]) => Promise<void>,
    private readonly options: WelcomeBatcherOptions = DEFAULT_WELCOME_TIMING,
    private readonly onError: (cause: unknown) => void = () => undefined,
  ) {}

  add(groupJid: string, participants: string[]): void {
    if (participants.length === 0) return;
    const batch = this.pending.get(groupJid) ?? new Set<string>();
    for (const participant of participants) batch.add(participant);
    this.pending.set(groupJid, batch);

    if (this.timers.has(groupJid)) return;
    const last = this.lastSentAt.get(groupJid);
    const sinceLast = last === undefined ? Infinity : Date.now() - last;
    const delay = Math.max(this.options.windowMs, this.options.minGapMs - sinceLast);
    this.timers.set(
      groupJid,
      setTimeout(() => void this.flush(groupJid), delay),
    );
  }

  private async flush(groupJid: string): Promise<void> {
    this.timers.delete(groupJid);
    const batch = this.pending.get(groupJid);
    this.pending.delete(groupJid);
    if (!batch || batch.size === 0) return;
    this.lastSentAt.set(groupJid, Date.now());
    try {
      await this.send(groupJid, [...batch]);
    } catch (cause) {
      this.onError(cause);
    }
  }

  /** Cancel anything pending, e.g. on shutdown. */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }
}
