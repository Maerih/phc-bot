/**
 * When the AI may answer a private chat on its own.
 *
 * The bot often runs on the owner's personal number, so friends' messages must
 * reach the owner, not the AI. Three layers decide:
 *
 * - The mode (`.aimode on` / `.aimode off`, off by default). On: the AI answers every
 *   private message. Off: only people who started with an AI command
 *   (.cv, .ask, .profile, .apply…), for 30 minutes after their last message,
 *   so follow-ups such as "YES" or their details still reach it.
 * - Taking over: when the owner types in a chat themselves, the AI steps back
 *   there (its conversation ends; with the mode on, it stays quiet for 12 hours).
 * - `.aimode stop` / `.aimode start` inside one chat: never / again, for that chat.
 *
 * Commands always work for everyone; this only governs plain messages and
 * documents. The owner's own "Message yourself" chat always reaches the AI.
 */
import { getSetting, setSetting } from './store.js';

const SESSION_MS = 30 * 60_000;
const TAKEOVER_MS = 12 * 3_600_000;

/** Chats with an AI conversation going, until when. */
const sessions = new Map<string, number>();
/** Chats the owner took over, until when. */
const takenOver = new Map<string, number>();

let modeCache: { value: boolean; at: number } | null = null;
let stoppedCache: { value: Set<string>; at: number } | null = null;
const CACHE_MS = 60_000;

export async function aiModeOn(): Promise<boolean> {
  if (modeCache && Date.now() - modeCache.at < CACHE_MS) return modeCache.value;
  const value = (await getSetting('dm_ai').catch(() => null)) === 'on';
  modeCache = { value, at: Date.now() };
  return value;
}

export async function setAiMode(on: boolean): Promise<void> {
  await setSetting('dm_ai', on ? 'on' : 'off');
  modeCache = { value: on, at: Date.now() };
}

async function stoppedChats(): Promise<Set<string>> {
  if (stoppedCache && Date.now() - stoppedCache.at < CACHE_MS) return stoppedCache.value;
  let list: string[] = [];
  try {
    const raw = await getSetting('dm_ai_stopped');
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) list = parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    // unreadable: treat as none stopped
  }
  stoppedCache = { value: new Set(list), at: Date.now() };
  return stoppedCache.value;
}

/** `.aimode stop` / `.aimode start` in one chat. */
export async function setChatStopped(chatJid: string, stopped: boolean): Promise<void> {
  const chats = new Set(await stoppedChats());
  if (stopped) {
    chats.add(chatJid);
    sessions.delete(chatJid);
  } else {
    chats.delete(chatJid);
    takenOver.delete(chatJid);
  }
  await setSetting('dm_ai_stopped', JSON.stringify([...chats]));
  stoppedCache = { value: chats, at: Date.now() };
}

/** A member used an AI command, or the AI just answered: keep the conversation open. */
export function openSession(chatJid: string): void {
  sessions.set(chatJid, Date.now() + SESSION_MS);
  takenOver.delete(chatJid);
}

/** The owner wrote in this chat themselves: the AI steps back. */
export function ownerTookOver(chatJid: string): void {
  sessions.delete(chatJid);
  takenOver.set(chatJid, Date.now() + TAKEOVER_MS);
}

function live(map: Map<string, number>, chatJid: string): boolean {
  const until = map.get(chatJid);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  map.delete(chatJid);
  return false;
}

/** May the AI answer a plain message or document in this private chat? */
export async function aiMayAnswer(chatJid: string): Promise<boolean> {
  if ((await stoppedChats()).has(chatJid)) return false;
  if (live(sessions, chatJid)) return true;
  if (live(takenOver, chatJid)) return false;
  return aiModeOn();
}

export async function aiStatus(): Promise<{ mode: boolean; sessions: number; takenOver: number; stopped: number }> {
  const now = Date.now();
  return {
    mode: await aiModeOn(),
    sessions: [...sessions.values()].filter((until) => until > now).length,
    takenOver: [...takenOver.values()].filter((until) => until > now).length,
    stopped: (await stoppedChats()).size,
  };
}

/** Tests only. */
export function resetDmMode(): void {
  sessions.clear();
  takenOver.clear();
  modeCache = null;
  stoppedCache = null;
}
