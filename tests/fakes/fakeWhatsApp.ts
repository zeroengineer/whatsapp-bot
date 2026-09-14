import type { AppConfig } from '../../src/config.js';
import { CommandRouter } from '../../src/core/router.js';
import type { BotState, Services } from '../../src/core/types.js';
import { ConfirmationService } from '../../src/services/confirmationService.js';
import { GroupService } from '../../src/services/groupService.js';
import { MemberService } from '../../src/services/memberService.js';
import { RemovalService, type RemovalOptions } from '../../src/services/removalService.js';
import { createNullLogger } from '../../src/utils/logger.js';
import { LeaveService } from '../../src/services/leaveService.js';
import {
  ChatDeleteUnavailableError,
  GroupNotFoundError,
  NotConnectedError,
  type ConnectionStatus,
  type GroupInfo,
  type IncomingMessage,
  type Participant,
  type ParticipantUpdateResult,
  type SelfInfo,
  type WhatsAppClient,
} from '../../src/whatsapp/client.js';

export const OWNER = '919999999999';
export const SELF: SelfInfo = { phoneNumber: OWNER, pnJid: `${OWNER}@s.whatsapp.net`, lidJid: '11111111111111@lid', name: 'Me' };

export const pn = (digits: string, name?: string, role: Participant['role'] = 'member'): Participant => ({
  jid: `${digits}@s.whatsapp.net`,
  phoneNumber: digits,
  name,
  role,
});

export const lidP = (lid: string, name?: string, role: Participant['role'] = 'member'): Participant => ({
  jid: `${lid}@lid`,
  lid: `${lid}@lid`,
  name,
  role,
});

type RemoveHandler = (groupJid: string, jids: string[], call: number) => Promise<ParticipantUpdateResult[]> | ParticipantUpdateResult[];

export class FakeWhatsAppClient implements WhatsAppClient {
  status: ConnectionStatus = 'open';
  self: SelfInfo | undefined = SELF;
  groups = new Map<string, GroupInfo>();
  sent: { chatJid: string; text: string }[] = [];
  removeCalls: { groupJid: string; jids: string[] }[] = [];
  /** Custom removal behaviour; default removes everyone successfully. */
  onRemove: RemoveHandler | undefined;
  /** Resolve value for waitForConnection. */
  reconnects = true;
  private msgCounter = 0;

  addGroup(group: GroupInfo, opts: { deletable?: boolean } = {}): GroupInfo {
    this.groups.set(group.jid, structuredClone(group));
    if (opts.deletable !== false) this.deletableChats.add(group.jid);
    return group;
  }

  getSelf() {
    return this.self;
  }
  getConnectionStatus() {
    return this.status;
  }
  async waitForConnection(): Promise<boolean> {
    if (this.status === 'open') return true;
    if (this.reconnects) {
      this.status = 'open';
      return true;
    }
    return false;
  }
  async listGroups(): Promise<GroupInfo[]> {
    if (this.status !== 'open') throw new NotConnectedError();
    return [...this.groups.values()].filter((g) => !this.leftGroups.has(g.jid)).map((g) => structuredClone(g));
  }
  async getGroup(jid: string): Promise<GroupInfo> {
    if (this.status !== 'open') throw new NotConnectedError();
    const g = this.groups.get(jid);
    if (!g || this.leftGroups.has(jid)) throw new GroupNotFoundError(jid);
    return structuredClone(g);
  }
  async removeParticipants(groupJid: string, jids: string[]): Promise<ParticipantUpdateResult[]> {
    if (this.status !== 'open') throw new NotConnectedError();
    this.removeCalls.push({ groupJid, jids: [...jids] });
    this.callLog.push(`remove:${groupJid}`);
    const results = this.onRemove
      ? await this.onRemove(groupJid, jids, this.removeCalls.length)
      : jids.map((jid) => ({ jid, status: '200' }));
    // Apply successful removals to the fake group state.
    const g = this.groups.get(groupJid);
    if (g) {
      const removed = new Set(results.filter((r) => r.status === '200').map((r) => r.jid));
      g.participants = g.participants.filter((p) => !removed.has(p.jid));
    }
    return results;
  }
  /** Chats that can be deleted (addGroup marks every group deletable by default). */
  deletableChats = new Set<string>();
  leftGroups = new Set<string>();
  demoteCalls: { groupJid: string; jids: string[] }[] = [];
  leaveCalls: string[] = [];
  deleteChatCalls: string[] = [];
  /** Ordered log of destructive calls, e.g. "demote:g@g.us", "remove:g@g.us", "leave:g@g.us", "delete:g@g.us". */
  callLog: string[] = [];
  onDemote: RemoveHandler | undefined;
  onLeave: ((groupJid: string) => Promise<void> | void) | undefined;
  onDeleteChat: ((groupJid: string) => Promise<void> | void) | undefined;

  async demoteParticipants(groupJid: string, jids: string[]): Promise<ParticipantUpdateResult[]> {
    if (this.status !== 'open') throw new NotConnectedError();
    this.demoteCalls.push({ groupJid, jids: [...jids] });
    this.callLog.push(`demote:${groupJid}`);
    const results = this.onDemote ? await this.onDemote(groupJid, jids, this.demoteCalls.length) : jids.map((jid) => ({ jid, status: '200' }));
    const g = this.groups.get(groupJid);
    if (g) {
      const ok = new Set(results.filter((r) => r.status === '200').map((r) => r.jid));
      g.participants = g.participants.map((p) => (ok.has(p.jid) ? { ...p, role: 'member' as const } : p));
    }
    return results;
  }

  async leaveGroup(groupJid: string): Promise<void> {
    if (this.status !== 'open') throw new NotConnectedError();
    this.leaveCalls.push(groupJid);
    this.callLog.push(`leave:${groupJid}`);
    if (this.onLeave) return this.onLeave(groupJid);
    this.leftGroups.add(groupJid);
  }

  canDeleteChat(groupJid: string): boolean {
    return this.deletableChats.has(groupJid);
  }

  async deleteChatForMe(groupJid: string): Promise<void> {
    if (this.status !== 'open') throw new NotConnectedError();
    if (!this.deletableChats.has(groupJid)) throw new ChatDeleteUnavailableError(groupJid);
    this.callLog.push(`delete:${groupJid}`);
    if (this.onDeleteChat) await this.onDeleteChat(groupJid);
    this.deleteChatCalls.push(groupJid);
  }

  async sendText(chatJid: string, text: string): Promise<string> {
    this.sent.push({ chatJid, text });
    return `BOT-${++this.msgCounter}`;
  }
  lastReply(): string {
    return this.sent.at(-1)?.text ?? '';
  }
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ownerPhone: OWNER,
    commandPrefix: '!',
    logLevel: 'info',
    dryRun: false,
    authMethod: 'qr',
    authDir: '/tmp/auth',
    logDir: '/tmp/logs',
    dataDir: '/tmp/data',
    confirmTtlMs: 120_000,
    removeBatchSize: 5,
    removeBatchDelayMs: 0,
    operationTimeoutMs: 30_000,
    ...overrides,
  };
}

export function collegeGroup(): GroupInfo {
  return {
    jid: 'college@g.us',
    name: 'College Group',
    participants: [
      pn('911000000001', 'Rahul'),
      pn('911000000002', 'Akhil', 'admin'),
      pn('911000000003', 'Neha'),
      pn('911000000004', 'Arun'),
      pn('911000000005', 'John', 'superadmin'),
      { ...pn(OWNER, 'Me', 'admin') },
    ],
  };
}

export function createHarness(opts: { config?: Partial<AppConfig>; removal?: Partial<RemovalOptions>; now?: () => number } = {}) {
  let clock = opts.now ? undefined : 1_700_000_000_000;
  const now = opts.now ?? (() => clock!);
  const advance = (ms: number) => {
    if (clock !== undefined) clock += ms;
  };
  const wa = new FakeWhatsAppClient();
  const config = testConfig(opts.config);
  const logger = createNullLogger();
  const state: BotState = { startedAt: now(), memberSnapshots: new Map() };
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  const removal = new RemovalService(wa, logger, {
    batchSize: config.removeBatchSize,
    batchDelayMs: config.removeBatchDelayMs,
    sleep,
    reconnectWaitMs: 10,
    ...opts.removal,
  });
  const services: Services = {
    groups: new GroupService(wa, state),
    members: new MemberService(state),
    confirmations: new ConfirmationService(config.confirmTtlMs, now),
    removal,
    leave: new LeaveService(wa, removal, logger, { batchDelayMs: config.removeBatchDelayMs, sleep, now, leaveNoticeWaitMs: 0 }),
  };
  const router = new CommandRouter({ wa, config, logger, state, services, now });

  let id = 0;
  const ownerMsg = (text: string, extra: Partial<IncomingMessage> = {}): IncomingMessage => ({
    id: `MSG-${++id}`,
    chatJid: SELF.pnJid,
    fromMe: true,
    text,
    timestamp: now(),
    ...extra,
  });
  /** Send an owner message through the full pipeline and return the last reply. */
  const say = async (text: string, extra: Partial<IncomingMessage> = {}) => {
    const before = wa.sent.length;
    await router.handle(ownerMsg(text, extra));
    return wa.sent.slice(before).map((s) => s.text).join('\n---\n');
  };

  return { wa, config, state, services, router, now, advance, ownerMsg, say, sleeps };
}
