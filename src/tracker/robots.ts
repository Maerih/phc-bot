/**
 * robots.txt, honoured.
 *
 * Only the rules that apply to every robot ("User-agent: *") or to this bot by
 * name are read; Allow beats Disallow when it is the longer match, as the
 * standard says. A robots.txt that cannot be fetched means no restrictions,
 * which is also what the standard says.
 */
import { TtlCache } from '../core/cache.js';
import { USER_AGENT } from '../sources/common/http.js';

interface Rules {
  allow: string[];
  disallow: string[];
}

const cache = new TtlCache<Rules>(24 * 60 * 60_000, 500);
const BOT_TOKEN = 'phc-platform';

export function parseRobots(text: string): Rules {
  const rules: Rules = { allow: [], disallow: [] };
  let applies = false;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const field = (match[1] ?? '').toLowerCase();
    const value = (match[2] ?? '').trim();
    if (field === 'user-agent') {
      const agent = value.toLowerCase();
      const matches = agent === '*' || agent.includes(BOT_TOKEN);
      applies = lastWasAgent ? applies || matches : matches;
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!applies) continue;
    if (field === 'disallow' && value) rules.disallow.push(value);
    if (field === 'allow' && value) rules.allow.push(value);
  }
  return rules;
}

function matchLength(pattern: string, path: string): number {
  const regex = new RegExp(
    `^${pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\\\$$/, '$')}`,
  );
  return regex.test(path) ? pattern.length : -1;
}

export function allowedBy(rules: Rules, path: string): boolean {
  const disallow = Math.max(-1, ...rules.disallow.map((pattern) => matchLength(pattern, path)));
  if (disallow < 0) return true;
  const allow = Math.max(-1, ...rules.allow.map((pattern) => matchLength(pattern, path)));
  return allow >= disallow;
}

export async function isAllowed(url: string): Promise<boolean> {
  const target = new URL(url);
  const origin = target.origin;
  let rules = cache.get(origin);
  if (!rules) {
    try {
      const response = await fetch(`${origin}/robots.txt`, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      rules = response.ok ? parseRobots((await response.text()).slice(0, 200_000)) : { allow: [], disallow: [] };
    } catch {
      rules = { allow: [], disallow: [] };
    }
    cache.set(origin, rules);
  }
  return allowedBy(rules, target.pathname + target.search);
}
