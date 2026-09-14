import { describe, expect, it } from 'vitest';
import { IndexSpecError, parseGroupSelection, parseIndexSpec, parseInput, splitGroupAndIndexes, unquote } from '../src/core/parser.js';

describe('parseInput', () => {
  it('parses a simple command', () => {
    expect(parseInput('!help', '!')).toEqual({ kind: 'command', command: { name: 'help', args: '', dryRun: false } });
  });

  it('lowercases command names and keeps group names with spaces', () => {
    expect(parseInput('  !Members   College   Group ', '!')).toEqual({
      kind: 'command',
      command: { name: 'members', args: 'College Group', dryRun: false },
    });
  });

  it('extracts --dry-run anywhere in the arguments', () => {
    expect(parseInput('!remove College Group 1,3 --dry-run', '!')).toEqual({
      kind: 'command',
      command: { name: 'remove', args: 'College Group 1,3', dryRun: true },
    });
    expect(parseInput('!removeall --dryrun College Group', '!')).toMatchObject({ command: { args: 'College Group', dryRun: true } });
  });

  it('supports a custom prefix', () => {
    expect(parseInput('/groups', '/')).toMatchObject({ kind: 'command', command: { name: 'groups' } });
    expect(parseInput('!groups', '/')).toEqual({ kind: 'none' });
  });

  it('recognises exact confirmation tokens only', () => {
    expect(parseInput('CONFIRM', '!')).toEqual({ kind: 'confirm', token: 'CONFIRM' });
    expect(parseInput(' CONFIRM   REMOVEALL ', '!')).toEqual({ kind: 'confirm', token: 'CONFIRM REMOVEALL' });
    expect(parseInput('CONFIRM LEAVE', '!')).toEqual({ kind: 'confirm', token: 'CONFIRM LEAVE' });
    expect(parseInput('confirm leave', '!')).toEqual({ kind: 'none' });
    expect(parseInput('confirm', '!')).toEqual({ kind: 'none' });
    expect(parseInput('CONFIRM please', '!')).toEqual({ kind: 'none' });
    expect(parseInput('Reply with:\nCONFIRM', '!')).toEqual({ kind: 'none' });
  });

  it('ignores ordinary text and malformed commands', () => {
    expect(parseInput('hello', '!')).toEqual({ kind: 'none' });
    expect(parseInput('!', '!')).toEqual({ kind: 'none' });
    expect(parseInput('!123', '!')).toEqual({ kind: 'none' });
  });
});

describe('parseIndexSpec', () => {
  it('parses comma, space and range selections, deduped and sorted', () => {
    expect(parseIndexSpec('1,3,4')).toEqual([1, 3, 4]);
    expect(parseIndexSpec('4 1 3')).toEqual([1, 3, 4]);
    expect(parseIndexSpec('2-5, 3 ,9')).toEqual([2, 3, 4, 5, 9]);
  });

  it('rejects invalid input', () => {
    expect(() => parseIndexSpec('')).toThrow(IndexSpecError);
    expect(() => parseIndexSpec('0')).toThrow(IndexSpecError);
    expect(() => parseIndexSpec('a,b')).toThrow(IndexSpecError);
    expect(() => parseIndexSpec('5-2')).toThrow(IndexSpecError);
    expect(() => parseIndexSpec('1-99999')).toThrow(IndexSpecError);
    expect(() => parseIndexSpec('-3')).toThrow(IndexSpecError);
  });
});

describe('parseGroupSelection', () => {
  it('treats a single number or name as one group', () => {
    expect(parseGroupSelection('3')).toEqual({ kind: 'single', query: '3' });
    expect(parseGroupSelection('College Group')).toEqual({ kind: 'single', query: 'College Group' });
    expect(parseGroupSelection('"Batch 2024"')).toEqual({ kind: 'single', query: 'Batch 2024' });
    expect(parseGroupSelection('2024')).toEqual({ kind: 'single', query: '2024' });
  });

  it('parses several group numbers', () => {
    expect(parseGroupSelection('1,3,7')).toEqual({ kind: 'numbers', indexes: [1, 3, 7] });
    expect(parseGroupSelection('7 3 1')).toEqual({ kind: 'numbers', indexes: [1, 3, 7] });
    expect(parseGroupSelection('1-4')).toEqual({ kind: 'numbers', indexes: [1, 2, 3, 4] });
    expect(parseGroupSelection('3,3')).toEqual({ kind: 'single', query: '3' });
  });

  it('parses names separated by |', () => {
    expect(parseGroupSelection('College Group | "Project Team"')).toEqual({ kind: 'names', names: ['College Group', 'Project Team'] });
    expect(parseGroupSelection('College Group |')).toEqual({ kind: 'single', query: 'College Group' });
  });

  it('rejects malformed number lists', () => {
    expect(() => parseGroupSelection('0,1')).toThrow(IndexSpecError);
    expect(() => parseGroupSelection('4-2')).toThrow(IndexSpecError);
  });
});

describe('splitGroupAndIndexes', () => {
  it('splits a group name from the index list', () => {
    expect(splitGroupAndIndexes('College Group 1,3,4')).toEqual([{ groupQuery: 'College Group', indexSpec: '1,3,4' }]);
  });

  it('offers every split when the group name ends with numbers', () => {
    expect(splitGroupAndIndexes('Batch 2024 1 3')).toEqual([
      { groupQuery: 'Batch 2024 1', indexSpec: '3' },
      { groupQuery: 'Batch 2024', indexSpec: '1 3' },
      { groupQuery: 'Batch', indexSpec: '2024 1 3' },
    ]);
  });

  it('uses quotes to disambiguate', () => {
    expect(splitGroupAndIndexes('"Batch 2024" 1,3')).toEqual([{ groupQuery: 'Batch 2024', indexSpec: '1,3' }]);
  });

  it('returns nothing when no indexes are given', () => {
    expect(splitGroupAndIndexes('College Group')).toEqual([]);
    expect(splitGroupAndIndexes('')).toEqual([]);
  });

  it('unquote strips surrounding quotes', () => {
    expect(unquote('"My Group"')).toBe('My Group');
    expect(unquote('My Group')).toBe('My Group');
  });
});
