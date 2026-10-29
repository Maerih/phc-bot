/**
 * Message-rate and repetition tracking for antispam.
 *
 * In memory on purpose: it only has to remember the last few minutes, and
 * losing that on a restart costs nothing. Bounded so a busy community cannot
 * grow it without limit.
 */
import { fingerprint } from './detect.js';

export interface SpamLimits {
  /** More than `burstMax` messages within `burstWindowMs` is flooding. */
  burstWindowMs: number;
  burstMax: number;
  /** The same message `repeatMax` times in one group within the window. */
  repeatWindowMs: number;
  repeatMax: number;
  /** The same message in this many different groups within the window. */
  crossGroupMax: number;
}

export const DEFAULT_SPAM_LIMITS: SpamLimits = {
  burstWindowMs: 10_000,
  burstMax: 6,
  repeatWindowMs: 10 * 60_000,
  repeatMax: 3,
  crossGroupMax: 3,
};

export type SpamKind = 'flood' | 'repeat' | 'crosspost';

interface Sighting {
  groupJid: string;
  at: number;
}

const MAX_KEYS = 5000;

export class SpamTracker {
  private readonly bursts = new Map<string, number[]>();
  private readonly repeats = new Map<string, Sighting[]>();

  constructor(private readonly limits: SpamLimits = DEFAULT_SPAM_LIMITS) {}

  /**
   * Record one message and say whether it is spam.
   *
   * `senderKey` should be stable across groups (the phone JID when known), or
   * cross-posting goes unseen.
   */
  record(groupJid: string, senderKey: string, text: string, now = Date.now()): SpamKind | null {
    const burstKey = `${groupJid}|${senderKey}`;
    const times = (this.bursts.get(burstKey) ?? []).filter((at) => now - at < this.limits.burstWindowMs);
    times.push(now);
    this.remember(this.bursts, burstKey, times);

    let verdict: SpamKind | null = times.length > this.limits.burstMax ? 'flood' : null;

    const print = fingerprint(text);
    if (print !== null) {
      const repeatKey = `${senderKey}|${print}`;
      const sightings = (this.repeats.get(repeatKey) ?? []).filter(
        (sighting) => now - sighting.at < this.limits.repeatWindowMs,
      );
      sightings.push({ groupJid, at: now });
      this.remember(this.repeats, repeatKey, sightings);

      const groups = new Set(sightings.map((sighting) => sighting.groupJid));
      const inThisGroup = sightings.filter((sighting) => sighting.groupJid === groupJid).length;
      // Cross-posting is the stronger signal, so it wins when both apply.
      if (groups.size >= this.limits.crossGroupMax) verdict = 'crosspost';
      else if (inThisGroup >= this.limits.repeatMax) verdict = verdict ?? 'repeat';
    }

    return verdict;
  }

  private remember<V>(map: Map<string, V>, key: string, value: V): void {
    // Re-inserting moves the key to the end, so the oldest key is first.
    map.delete(key);
    if (map.size >= MAX_KEYS) {
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
    map.set(key, value);
  }
}

export function describeSpam(kind: SpamKind): string {
  switch (kind) {
    case 'flood':
      return 'sending too many messages too fast';
    case 'repeat':
      return 'posting the same message repeatedly';
    case 'crosspost':
      return 'posting the same message across several groups';
  }
}
