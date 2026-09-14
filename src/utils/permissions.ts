import type { GroupInfo, IncomingMessage, Participant, SelfInfo } from '../whatsapp/client.js';

/** "919876543210:12@s.whatsapp.net" → { user: "919876543210", server: "s.whatsapp.net" } */
export function splitJid(jid: string | undefined): { user: string; server: string } | undefined {
  if (!jid) return undefined;
  const at = jid.indexOf('@');
  if (at < 0) return undefined;
  const user = jid.slice(0, at).split(':')[0] ?? '';
  return { user, server: jid.slice(at + 1) };
}

/** Strip device suffix: "919876543210:12@s.whatsapp.net" → "919876543210@s.whatsapp.net" */
export function normalizeJid(jid: string): string {
  const parts = splitJid(jid);
  return parts ? `${parts.user}@${parts.server}` : jid;
}

export const isGroupJid = (jid: string | undefined): boolean => !!jid && jid.endsWith('@g.us');

function sameUser(a: string | undefined, b: string | undefined): boolean {
  const pa = splitJid(a);
  const pb = splitJid(b);
  if (!pa || !pb || !pa.user) return false;
  // Treat c.us and s.whatsapp.net as the same phone-number server.
  const srv = (s: string) => (s === 'c.us' ? 's.whatsapp.net' : s);
  return pa.user === pb.user && srv(pa.server) === srv(pb.server);
}

/** True if `jid` refers to the authenticated account (by phone-number JID or LID). */
export function isSelfJid(jid: string | undefined, self: SelfInfo): boolean {
  return sameUser(jid, self.pnJid) || (!!self.lidJid && sameUser(jid, self.lidJid));
}

/** The configured owner must be the account the bot is linked to. */
export function ownerMatchesAccount(ownerPhone: string, self: SelfInfo): boolean {
  return ownerPhone === self.phoneNumber;
}

/**
 * Authorization gate. A message is an owner command only if ALL hold:
 *  - it was sent by the authenticated account itself (fromMe),
 *  - it is in the account's own "Message yourself" chat (never a group or someone else's DM),
 *  - the configured OWNER_PHONE is the authenticated account.
 */
export function isAuthorizedOwnerMessage(msg: IncomingMessage, self: SelfInfo | undefined, ownerPhone: string): boolean {
  if (!self) return false;
  if (!msg.fromMe) return false;
  if (!ownerMatchesAccount(ownerPhone, self)) return false;
  if (isGroupJid(msg.chatJid)) return false;
  return isSelfJid(msg.chatJid, self) || isSelfJid(msg.chatJidAlt, self);
}

export const isAdmin = (p: Participant): boolean => p.role === 'admin' || p.role === 'superadmin';

export function isSelfParticipant(p: Participant, self: SelfInfo): boolean {
  if (isSelfJid(p.jid, self) || isSelfJid(p.lid, self)) return true;
  return !!p.phoneNumber && p.phoneNumber === self.phoneNumber;
}

/** Does the authenticated account hold admin rights in this group? */
export function selfIsGroupAdmin(group: GroupInfo, self: SelfInfo): boolean {
  return group.participants.some((p) => isSelfParticipant(p, self) && isAdmin(p));
}
