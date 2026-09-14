import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LastMessageIndex } from '../src/whatsapp/messageIndex.js';

const msg = (id: string, remoteJid: string, ts: number, extra: { fromMe?: boolean; participant?: string } = {}) => ({
  key: { id, remoteJid, fromMe: extra.fromMe ?? false, participant: extra.participant ?? '911@s.whatsapp.net' },
  messageTimestamp: ts,
  message: { conversation: 'secret text that must never be stored' },
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('LastMessageIndex', () => {
  it('keeps the newest message per group', () => {
    const idx = new LastMessageIndex();
    expect(idx.record(msg('A', 'g@g.us', 100))).toBe(true);
    expect(idx.record(msg('B', 'g@g.us', 200))).toBe(true);
    expect(idx.record(msg('C', 'g@g.us', 150))).toBe(false);
    expect(idx.get('g@g.us')?.key.id).toBe('B');
  });

  it('ignores non-group chats and incomplete keys', () => {
    const idx = new LastMessageIndex();
    expect(idx.record(msg('A', '911@s.whatsapp.net', 100))).toBe(false);
    expect(idx.record({ key: { id: 'X', remoteJid: 'g@g.us', fromMe: false }, messageTimestamp: 100 })).toBe(false); // no participant
    expect(idx.record({ key: { id: 'Y', remoteJid: 'g@g.us', fromMe: true }, messageTimestamp: null })).toBe(false); // no timestamp
    expect(idx.record({ key: { id: 'Z', remoteJid: 'g@g.us', fromMe: true }, messageTimestamp: 5 })).toBe(true); // own message ok
    expect(idx.has('911@s.whatsapp.net')).toBe(false);
  });

  it('accepts Long-like timestamps', () => {
    const idx = new LastMessageIndex();
    idx.record({ key: { id: 'L', remoteJid: 'g@g.us', fromMe: true }, messageTimestamp: { toString: () => '1700000000' } });
    expect(idx.get('g@g.us')?.messageTimestamp).toBe(1700000000);
  });

  it('persists ids and timestamps only, and reloads them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'data', 'last-messages.json');
    const a = new LastMessageIndex(file);
    a.record(msg('A', 'g@g.us', 100));
    a.flush();
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('secret');
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');

    const b = new LastMessageIndex(file);
    b.load();
    expect(b.get('g@g.us')).toEqual({ key: { id: 'A', remoteJid: 'g@g.us', fromMe: false, participant: '911@s.whatsapp.net' }, messageTimestamp: 100 });
  });

  it('waitForNewer resolves when a newer message arrives, or times out', async () => {
    const idx = new LastMessageIndex();
    idx.record(msg('A', 'g@g.us', 100));
    const waiting = idx.waitForNewer('g@g.us', 150, 1000);
    idx.record(msg('B', 'g@g.us', 160));
    expect((await waiting)?.key.id).toBe('B');
    expect(await idx.waitForNewer('g@g.us', 999, 10)).toBeUndefined();
  });
});
