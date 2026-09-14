import type { AppConfig } from '../config.js';
import type { ConfirmationService } from '../services/confirmationService.js';
import type { GroupService } from '../services/groupService.js';
import type { MemberService } from '../services/memberService.js';
import type { RemovalService } from '../services/removalService.js';
import type { Logger } from '../utils/logger.js';
import type { IncomingMessage, Participant, WhatsAppClient } from '../whatsapp/client.js';
import type { ParsedCommand } from './parser.js';

/** An error whose message is safe and meaningful to show to the owner in WhatsApp. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export interface BotState {
  startedAt: number;
  lastCommand?: { name: string; at: number };
  /** Numbered group list from the most recent !groups (or implicit fetch). */
  groupList?: { jid: string; name: string }[];
  /** Ordered participant JIDs from the most recent !members per group. */
  memberSnapshots: Map<string, { jids: string[]; takenAt: number }>;
}

export interface Services {
  groups: GroupService;
  members: MemberService;
  confirmations: ConfirmationService;
  removal: RemovalService;
}

export interface CommandContext {
  msg: IncomingMessage;
  command: ParsedCommand;
  wa: WhatsAppClient;
  config: AppConfig;
  logger: Logger;
  state: BotState;
  services: Services;
  now: () => number;
  /** Send an extra message (e.g. progress) before the final reply. */
  send: (text: string) => Promise<void>;
}

export interface Command {
  name: string;
  usage: string;
  description: string;
  /** Long-running commands are exempt from the generic command timeout. */
  longRunning?: boolean;
  execute(ctx: CommandContext): Promise<string>;
}

export interface RemovalTarget {
  /** Index shown to the owner in the member list. */
  index: number;
  participant: Participant;
  label: string;
}

export type OperationType = 'remove' | 'removeall';

/** What to remove from one group. */
export interface GroupRemovalPlan {
  groupJid: string;
  groupName: string;
  targets: RemovalTarget[];
  protectedAdmins: number;
}

/** A confirmed-or-pending destructive operation over one or more groups (processed in order). */
export interface PendingOperation {
  id: string;
  type: OperationType;
  groups: GroupRemovalPlan[];
  dryRun: boolean;
  createdAt: number;
  expiresAt: number;
}

export const totalTargets = (op: Pick<PendingOperation, 'groups'>): number => op.groups.reduce((n, g) => n + g.targets.length, 0);

/** `remove in "College Group" (2 members)` or `removeall in 3 groups (89 members)` */
export function describeOperation(op: Pick<PendingOperation, 'type' | 'groups'>): string {
  const where = op.groups.length === 1 ? `"${op.groups[0]?.groupName}"` : `${op.groups.length} groups`;
  return `${op.type} in ${where} (${totalTargets(op)} members)`;
}
