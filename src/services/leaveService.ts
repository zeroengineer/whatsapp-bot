/**
 * Leave groups and delete their chats for this account.
 *
 * Per group: re-check → (admin groups) demote + remove other admins → leave → verify left → delete chat.
 * A group is only left if its chat can be deleted (owner's choice); failures after leaving are reported.
 */
import { UserError, type LeaveOperation, type LeavePlan, type RemovalTarget } from '../core/types.js';
import type { Logger } from '../utils/logger.js';
import { isAdmin, isSelfParticipant } from '../utils/permissions.js';
import { describeError, sleep as realSleep } from '../utils/retry.js';
import { ChatDeleteUnavailableError, GroupNotFoundError, NotConnectedError, type GroupInfo, type SelfInfo, type WhatsAppClient } from '../whatsapp/client.js';
import { GroupService } from './groupService.js';
import { memberLabel } from './memberService.js';
import type { RunningOperation } from './operationLock.js';
import type { FailedEntry, RemovalService } from './removalService.js';

export interface LeaveGroupReport {
  groupJid: string;
  groupName: string;
  dryRun: boolean;
  adminsRemoved: RemovalTarget[];
  adminsFailed: FailedEntry[];
  /** Dry run: admins that would be demoted and removed. */
  adminsWouldRemove: RemovalTarget[];
  creatorNotRemovable?: RemovalTarget;
  left: boolean;
  chatDeleted: boolean;
  /** Group was not touched (re-check failed, cancelled, connection lost). */
  skippedReason?: string;
  /** Something failed after actions started. */
  error?: string;
  stopped?: 'cancelled' | 'connection_lost';
}

export interface LeaveOperationReport {
  opId: string;
  dryRun: boolean;
  groups: LeaveGroupReport[];
  cancelled: boolean;
}

export interface LeaveServiceOptions {
  batchDelayMs: number;
  /** How long to wait for the "you left" notice before deleting the chat. */
  leaveNoticeWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Build a leave plan for one group from fresh metadata. */
export function buildLeavePlan(group: GroupInfo, index: number, self: SelfInfo): LeavePlan {
  const selfIsAdmin = GroupService.classify(group, self) !== 'nonadmin';
  const others = selfIsAdmin ? group.participants.filter((p) => !isSelfParticipant(p, self) && isAdmin(p)) : [];
  const toTarget = (p: GroupInfo['participants'][number], i: number): RemovalTarget => ({ index: i + 1, participant: p, label: memberLabel(p) });
  const creator = others.find((p) => p.role === 'superadmin');
  return {
    groupJid: group.jid,
    groupName: group.name,
    index,
    selfIsAdmin,
    adminsToRemove: others.filter((p) => p.role !== 'superadmin').map(toTarget),
    ...(creator ? { creatorNotRemovable: toTarget(creator, 0) } : {}),
  };
}

export class LeaveService {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly leaveNoticeWaitMs: number;

  constructor(
    private readonly wa: WhatsAppClient,
    private readonly removal: RemovalService,
    private readonly logger: Logger,
    private readonly opts: LeaveServiceOptions,
  ) {
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
    this.leaveNoticeWaitMs = opts.leaveNoticeWaitMs ?? 5000;
  }

  async execute(op: LeaveOperation, options: { onGroupDone?: (r: LeaveGroupReport, i: number, n: number) => Promise<void> | void } = {}): Promise<LeaveOperationReport> {
    if (op.groups.length === 0) throw new UserError('Nothing to leave.');
    const running = this.removal.lock.acquire({
      kind: 'leave',
      opId: op.id,
      groupName: op.groups[0]!.groupName,
      groupIndex: 0,
      groupCount: op.groups.length,
      total: op.groups.length,
    });
    const opLog = this.logger.child({ opId: op.id, action: 'leave', dryRun: op.dryRun });
    const result: LeaveOperationReport = { opId: op.id, dryRun: op.dryRun, groups: [], cancelled: false };

    try {
      opLog.info({ groupCount: op.groups.length, groupJids: op.groups.map((g) => g.groupJid) }, 'Leave operation started');
      let stop: LeaveGroupReport['stopped'];

      for (const [i, plan] of op.groups.entries()) {
        const report = LeaveService.emptyReport(plan, op.dryRun);
        if (!stop && running.cancelRequested) stop = 'cancelled';
        if (stop) {
          report.skippedReason = stop === 'cancelled' ? 'not attempted (cancelled)' : 'not attempted (connection lost)';
          result.groups.push(report);
          continue;
        }
        if (i > 0 && this.opts.batchDelayMs > 0) await this.sleep(this.opts.batchDelayMs);
        Object.assign(running, { groupName: plan.groupName, groupIndex: i, processed: i });

        const log = opLog.child({ groupJid: plan.groupJid, groupName: plan.groupName });
        await this.runGroup(plan, op.dryRun, running, report, log);
        log.info(
          {
            left: report.left,
            chatDeleted: report.chatDeleted,
            adminsRemoved: report.adminsRemoved.map((t) => t.participant.jid),
            adminsFailed: report.adminsFailed.map((f) => ({ jid: f.target.participant.jid, reason: f.reason })),
            skippedReason: report.skippedReason,
            error: report.error,
          },
          'Leave group finished',
        );
        stop = report.stopped;
        result.groups.push(report);
        running.processed = i + 1;
        try {
          await options.onGroupDone?.(report, i, op.groups.length);
        } catch (err) {
          opLog.warn({ err: describeError(err) }, 'Progress callback failed');
        }
      }

      result.cancelled = result.groups.some((g) => g.stopped === 'cancelled' || g.skippedReason === 'not attempted (cancelled)');
      opLog.info(
        {
          left: result.groups.filter((g) => g.left).length,
          chatsDeleted: result.groups.filter((g) => g.chatDeleted).length,
          errors: result.groups.filter((g) => g.error).length,
          skipped: result.groups.filter((g) => g.skippedReason).length,
          cancelled: result.cancelled,
        },
        'Leave operation finished',
      );
      return result;
    } finally {
      this.removal.lock.release(running);
    }
  }

  private static emptyReport(plan: LeavePlan, dryRun: boolean): LeaveGroupReport {
    return {
      groupJid: plan.groupJid,
      groupName: plan.groupName,
      dryRun,
      adminsRemoved: [],
      adminsFailed: [],
      adminsWouldRemove: [],
      creatorNotRemovable: plan.creatorNotRemovable,
      left: false,
      chatDeleted: false,
    };
  }

  private async runGroup(plan: LeavePlan, dryRun: boolean, running: RunningOperation, report: LeaveGroupReport, log: Logger): Promise<void> {
    // 1. Re-check with fresh metadata.
    const self = this.wa.getSelf();
    let group: GroupInfo;
    try {
      if (!self) throw new NotConnectedError();
      group = await this.removal.fetchGroupWithRetry(plan.groupJid);
    } catch (err) {
      if (err instanceof NotConnectedError) {
        report.skippedReason = 'not attempted (connection lost)';
        report.stopped = 'connection_lost';
      } else if (err instanceof GroupNotFoundError) {
        report.skippedReason = 'you are no longer a member of this group';
      } else {
        report.skippedReason = `could not load the group (${describeError(err)})`;
      }
      return;
    }

    const category = GroupService.classify(group, self);
    if (category === 'active') {
      report.skippedReason = 'regular members joined since the preview — use !removeall first';
      return;
    }
    if (plan.selfIsAdmin && category === 'nonadmin') {
      report.skippedReason = 'you are no longer an admin, so other admins cannot be removed — run !leave again for a fresh preview';
      return;
    }
    if (!this.wa.canDeleteChat(plan.groupJid)) {
      report.skippedReason = "chat can't be deleted (no known messages) — not left";
      return;
    }

    // Use fresh participant records; admins added since the preview are included, the creator is never targeted.
    const fresh = buildLeavePlan(group, plan.index, self);
    report.creatorNotRemovable = fresh.creatorNotRemovable;

    if (dryRun) {
      report.adminsWouldRemove = fresh.adminsToRemove;
      log.info({ wouldRemoveAdmins: fresh.adminsToRemove.map((t) => t.participant.jid) }, 'Dry run: no demote/remove/leave/delete requests sent');
      return;
    }

    // 2. Demote and remove other admins.
    if (fresh.adminsToRemove.length > 0) {
      const demoted = await this.removal.applyParticipantAction(plan.groupJid, fresh.adminsToRemove, 'demote', running, log);
      report.adminsFailed.push(...demoted.failed.map((f) => ({ ...f, reason: `demote failed: ${f.reason}` })));
      report.adminsFailed.push(...demoted.skipped, ...demoted.notAttempted);
      if (demoted.stopped) {
        report.stopped = demoted.stopped;
        report.error = demoted.stopped === 'cancelled' ? 'cancelled before leaving' : 'connection lost before leaving';
        return;
      }

      if (demoted.succeeded.length > 0) {
        const removed = await this.removal.applyParticipantAction(plan.groupJid, demoted.succeeded, 'remove', running, log);
        report.adminsRemoved.push(...removed.succeeded);
        report.adminsFailed.push(...removed.failed.map((f) => ({ ...f, reason: `remove failed: ${f.reason}` })));
        report.adminsFailed.push(...removed.skipped, ...removed.notAttempted);
        if (removed.stopped) {
          report.stopped = removed.stopped;
          report.error = removed.stopped === 'cancelled' ? 'cancelled before leaving' : 'connection lost before leaving';
          return;
        }
      }
    }

    if (running.cancelRequested) {
      report.stopped = 'cancelled';
      report.error = 'cancelled before leaving';
      return;
    }

    // 3. Leave and verify.
    const leaveStartedAt = this.now();
    try {
      if (!(await this.removal.ensureConnected())) throw new NotConnectedError();
      await this.wa.leaveGroup(plan.groupJid);
    } catch (err) {
      report.error = `leave failed (${describeError(err)})`;
      if (err instanceof NotConnectedError) report.stopped = 'connection_lost';
      return;
    }

    try {
      const after = await this.removal.fetchGroupWithRetry(plan.groupJid);
      if (after.participants.some((p) => isSelfParticipant(p, self))) {
        report.error = 'leave not confirmed — you are still listed as a member; chat not deleted';
        return;
      }
    } catch (err) {
      if (!(err instanceof GroupNotFoundError)) {
        report.error = `leave could not be verified (${describeError(err)}); chat not deleted`;
        if (err instanceof NotConnectedError) report.stopped = 'connection_lost';
        return;
      }
    }
    report.left = true;

    // 4. Delete the chat for me.
    try {
      await this.wa.deleteChatForMe(plan.groupJid, { newerThanMs: leaveStartedAt, waitMs: this.leaveNoticeWaitMs });
      report.chatDeleted = true;
    } catch (err) {
      const why = err instanceof ChatDeleteUnavailableError ? 'no known messages' : describeError(err);
      report.error = `chat delete FAILED (${why}): delete it manually`;
      if (err instanceof NotConnectedError) report.stopped = 'connection_lost';
    }
  }
}

function groupLine(r: LeaveGroupReport): string {
  if (r.skippedReason) return `${r.groupName} — SKIPPED: ${r.skippedReason}`;
  if (r.dryRun) {
    const steps = [r.adminsWouldRemove.length ? `would demote & remove ${r.adminsWouldRemove.length} admin(s)` : '', 'would leave', 'would delete chat'];
    return `${r.groupName} — ${steps.filter(Boolean).join(', ')}`;
  }
  const parts: string[] = [];
  if (r.adminsRemoved.length) parts.push(`removed ${r.adminsRemoved.length} admin(s)`);
  if (r.adminsFailed.length) parts.push(`${r.adminsFailed.length} admin(s) not removed`);
  if (r.left) parts.push('left');
  if (r.chatDeleted) parts.push('chat deleted');
  if (r.error) parts.push(r.error);
  return `${r.groupName} — ${parts.join(', ') || 'no changes'}`;
}

export function formatLeaveProgress(r: LeaveGroupReport, index: number, count: number): string {
  return `${groupLine(r)} (${index + 1}/${count})`;
}

export function formatLeaveReport(op: LeaveOperationReport): string {
  const n = op.groups.length;
  const lines: string[] = [];

  if (op.dryRun) {
    lines.push(`DRY RUN — nothing was changed (${n} group${n === 1 ? '' : 's'})`, '', ...op.groups.map(groupLine));
  } else {
    const left = op.groups.filter((g) => g.left).length;
    const deleted = op.groups.filter((g) => g.chatDeleted).length;
    const failed = op.groups.filter((g) => g.error).length;
    const skipped = op.groups.filter((g) => g.skippedReason).length;
    lines.push(op.cancelled ? `Leave cancelled — ${n} groups (partially completed)` : `Leave completed — ${n} group${n === 1 ? '' : 's'}`, '');
    lines.push(`Left: ${left} · Chats deleted: ${deleted} · Failed: ${failed}${skipped ? ` · Skipped: ${skipped}` : ''}`, '');
    lines.push(...op.groups.map(groupLine));
  }

  const notRemoved = op.groups.filter((g) => g.adminsFailed.length > 0 || g.creatorNotRemovable);
  if (notRemoved.length > 0) {
    lines.push('', 'Admins not removed:');
    for (const g of notRemoved) {
      lines.push(`${g.groupName}:`);
      if (g.creatorNotRemovable) lines.push(`- ${g.creatorNotRemovable.label} — group creator can't be removed`);
      lines.push(...g.adminsFailed.map((f) => `- ${f.target.label} — ${f.reason}`));
    }
  }
  if (!op.dryRun && op.groups.some((g) => g.chatDeleted)) {
    lines.push('', 'Chat deletions are synced to your devices; your phone may take a moment to update.');
  }
  return lines.join('\n');
}
