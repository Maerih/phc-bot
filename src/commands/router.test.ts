import { describe, expect, it } from 'vitest';
import { parseInvocation } from './router.js';
import { findCommand, allCommands } from './registry.js';

describe('parseInvocation', () => {
  it('parses a bare command', () => {
    expect(parseInvocation('.help')).toEqual({ name: 'help', args: '' });
  });

  it('parses a command with arguments', () => {
    expect(parseInvocation('.job public health')).toEqual({ name: 'job', args: 'public health' });
  });

  it('is case insensitive on the command name', () => {
    expect(parseInvocation('.HELP')?.name).toBe('help');
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseInvocation('   .jobs   nairobi   ')).toEqual({ name: 'jobs', args: 'nairobi' });
  });

  it('ignores ordinary conversation', () => {
    expect(parseInvocation('hello everyone')).toBeNull();
    expect(parseInvocation('')).toBeNull();
  });

  it('ignores a bare prefix', () => {
    // A stray "." in a group chat must not be treated as a command.
    expect(parseInvocation('.')).toBeNull();
    expect(parseInvocation('.   ')).toBeNull();
  });

  it('preserves multi-line arguments', () => {
    expect(parseInvocation('.job public\nhealth')?.args).toBe('public\nhealth');
  });
});

describe('command registry', () => {
  it('resolves commands by name and by alias', () => {
    expect(findCommand('help')?.name).toBe('help');
    expect(findCommand('commands')?.name).toBe('help');
    expect(findCommand('scholarship')?.name).toBe('scholarships');
  });

  it('returns undefined for unknown commands', () => {
    expect(findCommand('definitelynotacommand')).toBeUndefined();
  });

  it('gives every command a usage string and summary', () => {
    for (const command of allCommands()) {
      expect(command.usage, `${command.name} usage`).toBeTruthy();
      expect(command.summary, `${command.name} summary`).toBeTruthy();
    }
  });
});
