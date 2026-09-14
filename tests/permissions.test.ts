import { describe, expect, it } from 'vitest';
import { isAdmin, isAuthorizedOwnerMessage, isSelfParticipant, normalizeJid, selfIsGroupAdmin } from '../src/utils/permissions.js';
import type { IncomingMessage } from '../src/whatsapp/client.js';
import { collegeGroup, lidP, OWNER, pn, SELF } from './fakes/fakeWhatsApp.js';

const msg = (overrides: Partial<IncomingMessage>): IncomingMessage => ({
  id: 'x',
  chatJid: SELF.pnJid,
  fromMe: true,
  text: '!help',
  timestamp: Date.now(),
  ...overrides,
});

describe('owner authorization', () => {
  it('accepts fromMe messages in the self-chat (phone-number JID)', () => {
    expect(isAuthorizedOwnerMessage(msg({}), SELF, OWNER)).toBe(true);
  });

  it('accepts the self-chat addressed by LID or with a device suffix', () => {
    expect(isAuthorizedOwnerMessage(msg({ chatJid: '11111111111111@lid' }), SELF, OWNER)).toBe(true);
    expect(isAuthorizedOwnerMessage(msg({ chatJid: `${OWNER}:23@s.whatsapp.net` }), SELF, OWNER)).toBe(true);
    expect(isAuthorizedOwnerMessage(msg({ chatJid: '22222@lid', chatJidAlt: SELF.pnJid }), SELF, OWNER)).toBe(true);
  });

  it('rejects messages from other people', () => {
    expect(isAuthorizedOwnerMessage(msg({ fromMe: false, chatJid: '918888888888@s.whatsapp.net' }), SELF, OWNER)).toBe(false);
    // Even a spoofed "self chat" message not marked fromMe is rejected.
    expect(isAuthorizedOwnerMessage(msg({ fromMe: false }), SELF, OWNER)).toBe(false);
  });

  it('rejects the owner typing commands in groups or other DMs', () => {
    expect(isAuthorizedOwnerMessage(msg({ chatJid: 'college@g.us' }), SELF, OWNER)).toBe(false);
    expect(isAuthorizedOwnerMessage(msg({ chatJid: '918888888888@s.whatsapp.net' }), SELF, OWNER)).toBe(false);
  });

  it('rejects when OWNER_PHONE is not the linked account or not connected', () => {
    expect(isAuthorizedOwnerMessage(msg({}), SELF, '918888888888')).toBe(false);
    expect(isAuthorizedOwnerMessage(msg({}), undefined, OWNER)).toBe(false);
  });
});

describe('admin detection', () => {
  it('detects admin and superadmin roles', () => {
    expect(isAdmin(pn('1', 'a', 'admin'))).toBe(true);
    expect(isAdmin(pn('1', 'a', 'superadmin'))).toBe(true);
    expect(isAdmin(pn('1', 'a', 'member'))).toBe(false);
  });

  it('detects whether the account is admin, via PN or LID', () => {
    const group = collegeGroup();
    expect(selfIsGroupAdmin(group, SELF)).toBe(true);

    const lidGroup = { ...group, participants: [lidP('11111111111111', 'Me', 'admin'), pn('911', 'X')] };
    expect(selfIsGroupAdmin(lidGroup, SELF)).toBe(true);

    const notAdmin = { ...group, participants: group.participants.map((p) => (p.phoneNumber === OWNER ? { ...p, role: 'member' as const } : p)) };
    expect(selfIsGroupAdmin(notAdmin, SELF)).toBe(false);
  });

  it('matches self participant by phone number field', () => {
    expect(isSelfParticipant({ jid: '999@lid', phoneNumber: OWNER, role: 'member' }, SELF)).toBe(true);
    expect(isSelfParticipant(pn('911000000001'), SELF)).toBe(false);
  });

  it('normalizes device suffixes', () => {
    expect(normalizeJid('123:4@s.whatsapp.net')).toBe('123@s.whatsapp.net');
  });
});
