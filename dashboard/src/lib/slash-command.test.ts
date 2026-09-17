import { describe, expect, it } from 'vitest';
import {
  bareSlashCommandName,
  formatSlashCommandName,
  slashCommandMatchesQuery,
} from './slash-command';

describe('bareSlashCommandName', () => {
  it('strips a leading slash', () => expect(bareSlashCommandName('/afk')).toBe('afk'));
  it('returns bare names unchanged', () => expect(bareSlashCommandName('afk')).toBe('afk'));
  it('returns empty string for "/"', () => expect(bareSlashCommandName('/')).toBe(''));
  it('strips only the first slash', () => expect(bareSlashCommandName('//afk')).toBe('/afk'));
  it('handles empty string', () => expect(bareSlashCommandName('')).toBe(''));
});

describe('formatSlashCommandName', () => {
  it('adds a slash to a bare name', () => expect(formatSlashCommandName('afk')).toBe('/afk'));
  it('keeps one slash for prefixed names', () => expect(formatSlashCommandName('/afk')).toBe('/afk'));
  it('returns "/" for empty string', () => expect(formatSlashCommandName('')).toBe('/'));
});

describe('slashCommandMatchesQuery', () => {
  it('matches bare query against prefixed name', () => {
    expect(slashCommandMatchesQuery('/afk', 'af')).toBe(true);
  });
  it('matches prefixed query against prefixed name', () => {
    expect(slashCommandMatchesQuery('/afk', '/af')).toBe(true);
  });
  it('rejects non-matching query', () => {
    expect(slashCommandMatchesQuery('/afk', 'rev')).toBe(false);
  });
  it('matches empty query against any name', () => {
    expect(slashCommandMatchesQuery('/afk', '')).toBe(true);
  });
  it('matches bare name against bare query', () => {
    expect(slashCommandMatchesQuery('afk', 'af')).toBe(true);
  });
});
