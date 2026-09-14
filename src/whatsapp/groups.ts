/**
 * Baileys implementation of the WhatsAppClient interface: groups, participants, messaging.
 */
import type { GroupMetadata, GroupParticipant } from 'baileys';
import type { Logger } from '../utils/logger.js';
import { normalizeJid, splitJid } from '../utils/permissions.js';
import { errorStatusCode, withTimeout } from '../utils/retry.js';
import {
  ChatDeleteUnavailableError,
  GroupNotFoundError,
  NotConnectedError,
  type ConnectionStatus,
  type GroupInfo,
  type Participant,
  type ParticipantUpdateResult,
  type SelfInfo,
  type WhatsAppClient,
} from './client.js';
import type { WhatsAppConnection } from './connection.js';
import type { LastMessageIndex } from './messageIndex.js';

const digitsOf = (jidOrPhone: string | undefined): string | undefined => {
  if (!jidOrPhone) return undefined;
  const user = jidOrPhone.includes('@') ? splitJid(jidOrPhone)?.user : jidOrPhone;
  return user && /^\d+$/.test(user) ? user : undefined;
};

export class BaileysWhatsAppClient implements WhatsAppClient {
  constructor(
    private readonly connection: WhatsAppConnection,
    private readonly logger: Logger,
    private readonly timeoutMs: number,
    private readonly messageIndex: LastMessageIndex,
  ) {}

  private socket() {
    const sock = this.connection.getSocket();
    if (!sock) throw new NotConnectedError();
    return sock;
  }

  getSelf(): SelfInfo | undefined {
    return this.connection.getSelf();
  }

  getConnectionStatus(): ConnectionStatus {
    return this.connection.getStatus();
  }

  waitForConnection(timeoutMs: number): Promise<boolean> {
    return this.connection.waitForOpen(timeoutMs);
  }

  async listGroups(): Promise<GroupInfo[]> {
    const sock = this.socket();
    const all = await withTimeout(sock.groupFetchAllParticipating(), this.timeoutMs, 'fetch groups');
    const groups: GroupInfo[] = [];
    for (const meta of Object.values(all)) {
      // A community "parent" is not a regular chat group; its members are managed via sub-groups.
      if (meta.isCommunity) continue;
      groups.push(await this.toGroupInfo(meta));
    }
    return groups;
  }

  async getGroup(jid: string): Promise<GroupInfo> {
    const sock = this.socket();
    try {
      const meta = await withTimeout(sock.groupMetadata(jid), this.timeoutMs, 'fetch group metadata');
      return await this.toGroupInfo(meta);
    } catch (err) {
      const code = errorStatusCode(err);
      if (code === 404 || code === 403 || code === 401) throw new GroupNotFoundError(jid);
      throw err;
    }
  }

  async removeParticipants(groupJid: string, participantJids: string[]): Promise<ParticipantUpdateResult[]> {
    const sock = this.socket();
    const results = await withTimeout(
      sock.groupParticipantsUpdate(groupJid, participantJids, 'remove'),
      this.timeoutMs,
      'remove participants',
    );
    return results.map((r) => ({ jid: r.jid ?? '', status: String(r.status) }));
  }

  async demoteParticipants(groupJid: string, participantJids: string[]): Promise<ParticipantUpdateResult[]> {
    const sock = this.socket();
    const results = await withTimeout(
      sock.groupParticipantsUpdate(groupJid, participantJids, 'demote'),
      this.timeoutMs,
      'demote participants',
    );
    return results.map((r) => ({ jid: r.jid ?? '', status: String(r.status) }));
  }

  async leaveGroup(groupJid: string): Promise<void> {
    const sock = this.socket();
    await withTimeout(sock.groupLeave(groupJid), this.timeoutMs, 'leave group');
  }

  canDeleteChat(groupJid: string): boolean {
    return this.messageIndex.has(groupJid);
  }

  async deleteChatForMe(groupJid: string, opts: { newerThanMs?: number; waitMs?: number } = {}): Promise<void> {
    let entry = this.messageIndex.get(groupJid);
    if (!entry) throw new ChatDeleteUnavailableError(groupJid);
    if (opts.newerThanMs !== undefined && opts.waitMs) {
      entry = (await this.messageIndex.waitForNewer(groupJid, Math.floor(opts.newerThanMs / 1000), opts.waitMs)) ?? this.messageIndex.get(groupJid) ?? entry;
    }
    const sock = this.socket();
    await withTimeout(
      sock.chatModify({ delete: true, lastMessages: [{ key: entry.key, messageTimestamp: entry.messageTimestamp }] }, groupJid),
      this.timeoutMs,
      'delete chat',
    );
  }

  async sendText(chatJid: string, text: string): Promise<string | undefined> {
    const sock = this.socket();
    const sent = await withTimeout(sock.sendMessage(chatJid, { text }), this.timeoutMs, 'send message');
    return sent?.key?.id ?? undefined;
  }

  private async toGroupInfo(meta: GroupMetadata): Promise<GroupInfo> {
    const participants = await Promise.all(meta.participants.map((p) => this.toParticipant(p)));
    return { jid: meta.id, name: meta.subject?.trim() || '(unnamed group)', participants };
  }

  private async toParticipant(p: GroupParticipant): Promise<Participant> {
    const isLid = p.id.endsWith('@lid');
    const lid = p.lid ?? (isLid ? p.id : undefined);
    let phoneNumber = digitsOf(p.phoneNumber) ?? (isLid ? undefined : digitsOf(p.id));

    if (!phoneNumber && lid) {
      try {
        const pn = await this.connection.getSocket()?.signalRepository.lidMapping.getPNForLID(lid);
        phoneNumber = digitsOf(pn ?? undefined);
      } catch (err) {
        this.logger.debug({ err: String(err) }, 'LID→PN lookup failed');
      }
    }

    const names = this.connection.contactNames;
    const name =
      p.name ??
      p.notify ??
      p.verifiedName ??
      names.get(normalizeJid(p.id)) ??
      (lid ? names.get(normalizeJid(lid)) : undefined) ??
      (phoneNumber ? names.get(`${phoneNumber}@s.whatsapp.net`) : undefined);

    return {
      jid: p.id,
      lid,
      phoneNumber,
      name: name || undefined,
      role: p.admin === 'superadmin' ? 'superadmin' : p.admin === 'admin' ? 'admin' : 'member',
    };
  }
}
