import { describe, expect, it } from 'vitest';
import { chunkMessage } from '../src/core/router.js';
import { collegeGroup, createHarness, SELF } from './fakes/fakeWhatsApp.js';

describe('router: authorization & safety', () => {
  it('responds to the owner in the self-chat', async () => {
    const h = createHarness();
    const reply = await h.say('!help');
    expect(reply).toContain('WhatsApp Group Bot — commands');
    expect(h.wa.sent[0]?.chatJid).toBe(SELF.pnJid);
  });

  it('ignores unauthorized users completely (no reply)', async () => {
    const h = createHarness();
    h.wa.addGroup(collegeGroup());
    await h.router.handle(h.ownerMsg('!groups', { fromMe: false, chatJid: '918888888888@s.whatsapp.net', senderJid: '918888888888@s.whatsapp.net' }));
    await h.router.handle(h.ownerMsg('!removeall 1', { fromMe: false, chatJid: 'college@g.us', senderJid: '911000000001@s.whatsapp.net' }));
    expect(h.wa.sent).toHaveLength(0);
    expect(h.services.confirmations.getPending()).toBeUndefined();
  });

  it('ignores owner commands typed inside a group', async () => {
    const h = createHarness();
    h.wa.addGroup(collegeGroup());
    await h.router.handle(h.ownerMsg('!members 1', { chatJid: 'college@g.us' }));
    expect(h.wa.sent).toHaveLength(0);
  });

  it('ignores a CONFIRM from someone else', async () => {
    const h = createHarness();
    h.wa.addGroup(collegeGroup());
    await h.say('!groups');
    await h.say('!remove 1 2');
    expect(h.services.confirmations.getPending()).toBeDefined();
    await h.router.handle(h.ownerMsg('CONFIRM', { fromMe: false, chatJid: '911000000001@s.whatsapp.net' }));
    expect(h.wa.removeCalls).toHaveLength(0);
    expect(h.services.confirmations.getPending()).toBeDefined();
  });

  it('processes a duplicated message id only once', async () => {
    const h = createHarness();
    const m = h.ownerMsg('!help');
    await h.router.handle(m);
    await h.router.handle({ ...m });
    expect(h.wa.sent).toHaveLength(1);
  });

  it("ignores the bot's own sent messages", async () => {
    const h = createHarness();
    await h.say('!help');
    const sentId = 'BOT-1';
    await h.router.handle(h.ownerMsg('!help', { id: sentId }));
    expect(h.wa.sent).toHaveLength(1);
  });

  it('ignores stale command messages from before startup', async () => {
    const h = createHarness();
    await h.router.handle(h.ownerMsg('!help', { timestamp: h.state.startedAt - 60_000 }));
    expect(h.wa.sent).toHaveLength(0);
  });

  it('ignores ordinary notes in the self-chat', async () => {
    const h = createHarness();
    await h.say('buy milk');
    expect(h.wa.sent).toHaveLength(0);
  });

  it('replies to unknown commands', async () => {
    const h = createHarness();
    expect(await h.say('!foo')).toContain('Unknown command "!foo"');
  });

  it('reports not connected cleanly', async () => {
    const h = createHarness();
    h.wa.status = 'closed';
    // sendText still works in the fake so we can observe the reply.
    expect(await h.say('!groups')).toContain('not connected');
  });

  it('never leaks internal error details', async () => {
    const h = createHarness();
    h.wa.listGroups = async () => {
      throw new Error('secret internal path /Users/x/auth/creds.json');
    };
    const reply = await h.say('!groups');
    expect(reply).toContain('Command failed');
    expect(reply).not.toContain('creds');
  });

  it('records the last command', async () => {
    const h = createHarness();
    await h.say('!help');
    expect(h.state.lastCommand?.name).toBe('help');
  });
});

describe('chunkMessage', () => {
  it('splits long text on line boundaries', () => {
    const text = Array.from({ length: 100 }, (_, i) => `${i + 1}. Member name number ${i + 1}`).join('\n');
    const chunks = chunkMessage(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    expect(chunks.join('\n')).toBe(text);
  });
});
