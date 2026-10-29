/**
 * `.ping` — liveness check. Deliberately touches nothing external.
 */
import { POWERED_BY } from '../../whatsapp/format.js';
import type { Command } from '../types.js';

const startedAt = Date.now();

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [days > 0 ? `${days}d` : '', hours > 0 ? `${hours}h` : '', minutes > 0 ? `${minutes}m` : '', `${seconds}s`];
  return parts.filter(Boolean).join(' ');
}

export const pingCommand: Command = {
  name: 'ping',
  aliases: ['alive', 'uptime'],
  category: 'system',
  summary: 'Check the assistant is running',
  usage: '.ping',
  exemptFromRateLimit: true,

  async handler(context) {
    const memoryMb = Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10;
    await context.reply(
      [
        '✅ *Online*',
        `Uptime: ${formatUptime(Date.now() - startedAt)}`,
        `Memory: ${memoryMb} MB`,
        '',
        `_${POWERED_BY}_`,
      ].join('\n'),
    );
  },
};
