/**
 * Command registry.
 *
 * Adding a command means writing its file and adding one import here — there is
 * no central switch statement to grow, which is the failure mode this replaces.
 * Name and alias collisions throw at startup rather than silently shadowing.
 */
import { logger } from '../core/logger.js';
import type { Command, CommandCategory } from './types.js';

import { aboutCommand } from './system/about.js';
import { helpCommand } from './system/help.js';
import { menuCommand, startCommand } from './system/menu.js';
import { pingCommand } from './system/ping.js';
import { sourcesCommand } from './system/sources.js';
import { detailsCommand } from './jobs/details.js';
import { jobCommand, jobsCommand } from './jobs/job.js';
import { nextCommand, prevCommand } from './jobs/paginate.js';
import { addCommand, demoteCommand, kickCommand, promoteCommand } from './group/manage.js';
import { closeCommand, lockCommand, openCommand, unlockCommand, welcomeCommand } from './group/settings.js';
import {
  antilinkCommand,
  antipromoCommand,
  antispamCommand,
  badwordCommand,
  modCommand,
  silenceCommand,
  silencedCommand,
  unsilenceCommand,
  warnLimitCommand,
} from './group/moderation.js';
import { resetWarnsCommand, warnCommand, warningsCommand } from './group/warn.js';
import { groupInfoCommand } from './group/info.js';
import { askCommand } from './ai/ask.js';
import {
  conferencesCommand,
  eventsCommand,
  fellowshipsCommand,
  grantsCommand,
  internshipsCommand,
  researchCommand,
  scholarshipsCommand,
  trainingCommand,
} from './opportunities/shortcuts.js';

const log = logger.child({ component: 'commands' });

/** Every command the platform knows about. */
const COMMANDS: readonly Command[] = [
  // system
  helpCommand,
  menuCommand,
  startCommand,
  aboutCommand,
  pingCommand,
  sourcesCommand,
  // opportunity search
  jobCommand,
  jobsCommand,
  scholarshipsCommand,
  internshipsCommand,
  fellowshipsCommand,
  researchCommand,
  grantsCommand,
  eventsCommand,
  conferencesCommand,
  trainingCommand,
  // group administration
  groupInfoCommand,
  addCommand,
  kickCommand,
  promoteCommand,
  demoteCommand,
  openCommand,
  closeCommand,
  lockCommand,
  unlockCommand,
  welcomeCommand,
  // moderation
  modCommand,
  antilinkCommand,
  antipromoCommand,
  antispamCommand,
  badwordCommand,
  silenceCommand,
  unsilenceCommand,
  silencedCommand,
  warnCommand,
  warningsCommand,
  resetWarnsCommand,
  warnLimitCommand,
  // assistant
  askCommand,
  // result navigation
  nextCommand,
  prevCommand,
  detailsCommand,
];

const byName = new Map<string, Command>();

for (const command of COMMANDS) {
  for (const name of [command.name, ...(command.aliases ?? [])]) {
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      throw new Error(
        `Command name collision on "${key}": both "${existing.name}" and "${command.name}" claim it.`,
      );
    }
    byName.set(key, command);
  }
}

log.info({ commands: COMMANDS.length, names: byName.size }, 'command registry built');

/** Resolve a command by name or alias. */
export function findCommand(name: string): Command | undefined {
  return byName.get(name.toLowerCase().trim());
}

export function allCommands(): readonly Command[] {
  return COMMANDS;
}

/** Commands grouped by category, for `.help`. */
export function commandsByCategory(includeAdmin: boolean): Map<CommandCategory, Command[]> {
  const grouped = new Map<CommandCategory, Command[]>();
  for (const command of COMMANDS) {
    if (command.adminOnly && !includeAdmin) continue;
    const bucket = grouped.get(command.category) ?? [];
    bucket.push(command);
    grouped.set(command.category, bucket);
  }
  return grouped;
}
