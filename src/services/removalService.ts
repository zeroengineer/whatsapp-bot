import { UserError, type GroupRemovalPlan, type RemovalOperation, type RemovalTarget } from '../core/types.js';
import { OperationLock, type RunningInfo, type RunningOperation } from './operationLock.js';
import type { Logger } from '../utils/logger.js';
import { isAdmin, isSelfParticipant, normalizeJid, selfIsGroupAdmin, splitJid } from '../utils/permissions.js';
import { backoffDelay, describeError, errorStatusCode, sleep as realSleep, TimeoutError } from '../utils/retry.js';
import { NotConnectedError, type GroupInfo, type Participant, type ParticipantUpdateResult, type WhatsAppClient } from '../whatsapp/client.js';
import { sameParticipant } from './memberService.js';

export interface RemovalOptions {
  batchSize: number;
  batchDelayMs: number;
  /** Attempts per batch for request-level failures. */
  maxBatchAttempts?: number;
  /** How long to wait for WhatsApp to reconnect before giving up. */
  reconnectWaitMs?: number;
  /** Minimum wait after a rate-limit (429) response. */
  rateLimitWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FailedEntry {
  target: RemovalTarget;
  reason: string;
}

export interface RemovalReport {
  opId: string;
  type: RemovalOperation['type'];
  groupJid: string;
  groupName: string;
  dryRun: boolean;
  /** Confirmed removed by WhatsApp (status 200) and, when verification ran, absent from the group. */
  removed: RemovalTarget[];
  /** Dry run only: members that would have been removed. */
  wouldRemove: RemovalTarget[];
  failed: FailedEntry[];
  /** Not removed by the bot and not attempted, with the reason (left the group, became admin, …). */
  skipped: FailedEntry[];
  /** Never sent to WhatsApp (connection lost, cancelled, aborted). */
  notAttempted: FailedEntry[];
  /** Set when the whole operation was aborted before any removal request. */
  abortedReason?: string;
  cancelled: boolean;
  /** Set when this group ended in a way that must stop the remaining groups. */
  stopped?: 'cancelled' | 'connection_lost';
  verified: boolean;
}

/** Result of a whole operation: one report per group, in processing order. */
export interface OperationReport {
  opId: string;
  type: RemovalOperation['type'];
  dryRun: boolean;
  groups: RemovalReport[];
  cancelled: boolean;
}

export interface ExecuteOptions {
  /** Called after each group finishes (index is 0-based). */
  onGroupDone?: (report: RemovalReport, index: number, count: number) => Promise<void> | void;
}

const TRANSIENT_STATUS = new Set(['408', '429', '500', '502', '503', '504']);
const TRANSIENT_CODES = new Set([408, 428, 429, 500, 502, 503, 504, 515]);

export function describeParticipantStatus(status: string): string {
  switch (status) {
    case '401':
    case '403':
      return 'permission error';
    case '404':
      return 'not in group';
    case '406':
      return 'not allowed by WhatsApp (e.g. group creator)';
    case '409':
      return 'conflicting change in progress';
    case '408':
    case '429':
    case '500':
    case '502':
    case '503':
    case '504':
      return 'temporary WhatsApp error';
    default:
      return `WhatsApp error ${status}`;
  }
}

export function isTransientError(err: unknown): boolean {
  if (err instanceof TimeoutError || err instanceof NotConnectedError) return true;
  const code = errorStatusCode(err);
  return code === undefined || TRANSIENT_CODES.has(code);
}

/** Match a WhatsApp result entry (which may use LID or PN addressing) to a target participant. */
export function resultMatches(result: ParticipantUpdateResult, p: Participant): boolean {
  if (!result.jid) return false;
  const r = normalizeJid(result.jid);
  if (r === normalizeJid(p.jid)) return true;
  if (p.lid && r === normalizeJid(p.lid)) return true;
  const user = splitJid(result.jid)?.user;
  return !!p.phoneNumber && result.jid.endsWith('@s.whatsapp.net') && user === p.phoneNumber;
}

export type ParticipantAction = 'remove' | 'demote';

/** Outcome of applying remove/demote to a list of participants in batches. */
export interface ParticipantActionResult {
  /** WhatsApp returned status 200. */
  succeeded: RemovalTarget[];
  failed: FailedEntry[];
  skipped: FailedEntry[];
  notAttempted: FailedEntry[];
  stopped?: 'cancelled' | 'connection_lost';
}

export type { RunningInfo } from './operationLock.js';

export class RemovalService {
  readonly lock: OperationLock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxBatchAttempts: number;
  private readonly reconnectWaitMs: number;
  private readonly rateLimitWaitMs: number;

  constructor(
    private readonly wa: WhatsAppClient,
    private readonly logger: Logger,
    private readonly opts: RemovalOptions,
    lock?: OperationLock,
  ) {
    this.lock = lock ?? new OperationLock();
    this.sleep = opts.sleep ?? realSleep;
    this.maxBatchAttempts = opts.maxBatchAttempts ?? 3;
    this.reconnectWaitMs = opts.reconnectWaitMs ?? 120_000;
    this.rateLimitWaitMs = opts.rateLimitWaitMs ?? 30_000;
  }

  /** The running destructive operation (removal or leave), if any. */
  getRunning(): RunningInfo | undefined {
    return this.lock.get();
  }

  /** Ask the running operation to stop after the current batch. Returns false if nothing is running. */
  requestCancel(): boolean {
    return this.lock.requestCancel();
  }

  /** Resolves when no operation is running or the timeout elapses. */
  waitForIdle(timeoutMs: number): Promise<boolean> {
    return this.lock.waitForIdle(timeoutMs);
  }

  async execute(op: RemovalOperation, options: ExecuteOptions = {}): Promise<OperationReport> {
    if (op.groups.length === 0) throw new UserError('Nothing to remove.');
    const running = this.lock.acquire({
      kind: 'removal',
      opId: op.id,
      groupName: op.groups[0]!.groupName,
      groupIndex: 0,
      groupCount: op.groups.length,
      total: op.groups[0]!.targets.length,
    });
    const opLog = this.logger.child({ opId: op.id, action: op.type, dryRun: op.dryRun });
    const result: OperationReport = { opId: op.id, type: op.type, dryRun: op.dryRun, groups: [], cancelled: false };

    try {
      opLog.info({ groupCount: op.groups.length, groupJids: op.groups.map((g) => g.groupJid) }, 'Operation started');
      let stop: RemovalReport['stopped'];

      for (const [i, plan] of op.groups.entries()) {
        const report = this.emptyReport(op, plan);
        if (!stop && running.cancelRequested) stop = 'cancelled';

        if (stop) {
          // Never send requests for groups after a cancellation or lost connection.
          const reason = stop === 'cancelled' ? 'not attempted (cancelled)' : 'not attempted (connection lost)';
          report.notAttempted = plan.targets.map((target) => ({ target, reason }));
          report.cancelled = stop === 'cancelled';
          result.groups.push(report);
          continue;
        }

        if (i > 0 && this.opts.batchDelayMs > 0) await this.sleep(this.opts.batchDelayMs);
        Object.assign(running, { groupName: plan.groupName, groupIndex: i, total: plan.targets.length, processed: 0 });
        await this.executeGroup(op, plan, running, report);
        stop = report.stopped;
        result.groups.push(report);
        try {
          await options.onGroupDone?.(report, i, op.groups.length);
        } catch (err) {
          opLog.warn({ err: describeError(err) }, 'Progress callback failed');
        }
      }

      result.cancelled = result.groups.some((g) => g.cancelled);
      const sum = (f: (r: RemovalReport) => number) => result.groups.reduce((n, r) => n + f(r), 0);
      opLog.info(
        {
          groupCount: result.groups.length,
          removed: sum((r) => r.removed.length),
          wouldRemove: sum((r) => r.wouldRemove.length),
          failed: sum((r) => r.failed.length),
          skipped: sum((r) => r.skipped.length),
          notAttempted: sum((r) => r.notAttempted.length),
          abortedGroups: result.groups.filter((r) => r.abortedReason).map((r) => r.groupJid),
          cancelled: result.cancelled,
        },
        'Operation finished',
      );
      return result;
    } finally {
      this.lock.release(running);
    }
  }

  private emptyReport(op: RemovalOperation, plan: GroupRemovalPlan): RemovalReport {
    return {
      opId: op.id,
      type: op.type,
      groupJid: plan.groupJid,
      groupName: plan.groupName,
      dryRun: op.dryRun,
      removed: [],
      wouldRemove: [],
      failed: [],
      skipped: [],
      notAttempted: [],
      cancelled: false,
      verified: false,
    };
  }

  private async executeGroup(op: RemovalOperation, plan: GroupRemovalPlan, running: RunningOperation, report: RemovalReport): Promise<void> {
    const log = this.logger.child({ opId: op.id, action: op.type, groupJid: plan.groupJid, groupName: plan.groupName, dryRun: op.dryRun });
    {
      log.info({ targetCount: plan.targets.length }, 'Removal operation started');
      await this.runGroup(plan, op.dryRun, running, report, log);
      log.info(
        {
          removed: report.removed.length,
          wouldRemove: report.wouldRemove.length,
          failed: report.failed.length,
          skipped: report.skipped.length,
          notAttempted: report.notAttempted.length,
          abortedReason: report.abortedReason,
          cancelled: report.cancelled,
          verified: report.verified,
          removedMembers: report.removed.map((t) => t.participant.jid),
          failedMembers: report.failed.map((f) => ({ jid: f.target.participant.jid, reason: f.reason })),
        },
        'Removal operation finished',
      );
    }
  }

  async fetchGroupWithRetry(groupJid: string): Promise<GroupInfo> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.maxBatchAttempts; attempt++) {
      try {
        if (!(await this.ensureConnected())) throw new NotConnectedError();
        return await this.wa.getGroup(groupJid);
      } catch (err) {
        lastErr = err;
        if (!isTransientError(err)) throw err;
        if (attempt < this.maxBatchAttempts - 1) await this.sleep(backoffDelay(attempt, 2000, 30_000));
      }
    }
    throw lastErr;
  }

  async ensureConnected(): Promise<boolean> {
    if (this.wa.getConnectionStatus() === 'open') return true;
    return this.wa.waitForConnection(this.reconnectWaitMs);
  }

  private async runGroup(plan: GroupRemovalPlan, dryRun: boolean, running: RunningOperation, report: RemovalReport, log: Logger): Promise<void> {
    // 1. Re-validate against fresh state immediately before acting.
    const self = this.wa.getSelf();
    let group: GroupInfo;
    try {
      if (!self) throw new NotConnectedError();
      group = await this.fetchGroupWithRetry(plan.groupJid);
    } catch (err) {
      const lost = err instanceof NotConnectedError;
      report.abortedReason = lost
        ? 'WhatsApp connection lost. Nobody was removed from this group.'
        : `could not load the group (${describeError(err)}). Nobody was removed.`;
      report.notAttempted = plan.targets.map((target) => ({ target, reason: lost ? 'not attempted (connection lost)' : 'not attempted' }));
      if (lost) report.stopped = 'connection_lost';
      return;
    }
    if (!selfIsGroupAdmin(group, self)) {
      report.abortedReason = 'you are no longer an administrator of this group. Nobody was removed.';
      report.notAttempted = plan.targets.map((target) => ({ target, reason: 'not attempted' }));
      return;
    }

    const eligible: RemovalTarget[] = [];
    for (const target of plan.targets) {
      const current = group.participants.find((p) => sameParticipant(p, target.participant));
      if (!current) report.skipped.push({ target, reason: 'no longer in group' });
      else if (isSelfParticipant(current, self)) report.skipped.push({ target, reason: 'this is your own account (protected)' });
      else if (isAdmin(current)) report.skipped.push({ target, reason: 'is now an administrator (protected)' });
      else eligible.push({ ...target, participant: current });
    }

    if (dryRun) {
      report.wouldRemove = eligible;
      log.info({ wouldRemove: eligible.map((t) => t.participant.jid) }, 'Dry run: no removal requests sent');
      return;
    }

    // 2. Remove in batches.
    const outcome = await this.applyParticipantAction(plan.groupJid, eligible, 'remove', running, log, plan.targets.length);
    const reportedRemoved = outcome.succeeded;
    report.failed.push(...outcome.failed);
    report.skipped.push(...outcome.skipped);
    report.notAttempted.push(...outcome.notAttempted);
    if (outcome.stopped) report.stopped = outcome.stopped;
    if (outcome.stopped === 'cancelled') report.cancelled = true;

    // 3. Verify: never report a removal the group state contradicts.
    if (reportedRemoved.length === 0) return;
    try {
      const after = await this.fetchGroupWithRetry(plan.groupJid);
      report.verified = true;
      for (const target of reportedRemoved) {
        if (after.participants.some((p) => sameParticipant(p, target.participant))) {
          report.failed.push({ target, reason: 'WhatsApp reported success but the member is still in the group' });
        } else {
          report.removed.push(target);
        }
      }
    } catch (err) {
      log.warn({ err: describeError(err) }, 'Post-removal verification failed; reporting WhatsApp-confirmed results');
      report.removed.push(...reportedRemoved);
      if (err instanceof NotConnectedError) report.stopped = 'connection_lost';
    }
  }

  /**
   * Apply remove/demote to participants in paced batches, with request retries, a one-time retry for
   * members with a transient status, and stops on cancellation or lost connection.
   * Only WhatsApp status 200 counts as success.
   */
  async applyParticipantAction(
    groupJid: string,
    targets: RemovalTarget[],
    action: ParticipantAction,
    running: RunningOperation,
    log: Logger,
    progressTotal = targets.length,
  ): Promise<ParticipantActionResult> {
    const out: ParticipantActionResult = { succeeded: [], failed: [], skipped: [], notAttempted: [] };
    const queue = [...targets];
    const retriedOnce = new Set<string>();
    let batchNo = 0;

    while (queue.length > 0) {
      if (running.cancelRequested) {
        out.stopped = 'cancelled';
        out.notAttempted.push(...queue.splice(0).map((target) => ({ target, reason: 'cancelled' })));
        break;
      }

      const batch = queue.splice(0, this.opts.batchSize);
      batchNo++;
      const outcome = await this.sendBatch(groupJid, batch, log, batchNo, action);

      if (outcome.kind === 'connection_lost') {
        out.stopped = 'connection_lost';
        out.notAttempted.push(...[...batch, ...queue.splice(0)].map((target) => ({ target, reason: 'not attempted (connection lost)' })));
        break;
      }
      if (outcome.kind === 'fatal') {
        out.failed.push(...batch.map((target) => ({ target, reason: outcome.reason })));
        out.notAttempted.push(...queue.splice(0).map((target) => ({ target, reason: `stopped after error: ${outcome.reason}` })));
        break;
      }
      if (outcome.kind === 'failed') {
        out.failed.push(...batch.map((target) => ({ target, reason: outcome.reason })));
      } else {
        for (const target of batch) {
          const result = outcome.results.find((r) => resultMatches(r, target.participant));
          if (!result) {
            out.failed.push({ target, reason: 'no confirmation from WhatsApp' });
          } else if (result.status === '200') {
            out.succeeded.push(target);
          } else if (result.status === '404' && outcome.attempts > 1) {
            // An earlier attempt may have succeeded before timing out; don't claim it either way.
            out.skipped.push({ target, reason: 'no longer in group (an earlier timed-out attempt may have removed them)' });
          } else if (TRANSIENT_STATUS.has(result.status) && !retriedOnce.has(target.participant.jid)) {
            retriedOnce.add(target.participant.jid);
            queue.push(target);
          } else {
            out.failed.push({ target, reason: describeParticipantStatus(result.status) });
          }
        }
      }

      running.processed = progressTotal - queue.length;
      if (queue.length > 0 && this.opts.batchDelayMs > 0) await this.sleep(this.opts.batchDelayMs);
    }
    return out;
  }

  private async sendBatch(
    groupJid: string,
    batch: RemovalTarget[],
    log: Logger,
    batchNo: number,
    action: ParticipantAction,
  ): Promise<
    | { kind: 'ok'; results: ParticipantUpdateResult[]; attempts: number }
    | { kind: 'failed'; reason: string }
    | { kind: 'fatal'; reason: string }
    | { kind: 'connection_lost' }
  > {
    const jids = batch.map((t) => t.participant.jid);
    for (let attempt = 1; attempt <= this.maxBatchAttempts; attempt++) {
      if (!(await this.ensureConnected())) {
        log.error({ batchNo }, 'Connection not restored in time; stopping removal');
        return { kind: 'connection_lost' };
      }
      try {
        const results =
          action === 'demote' ? await this.wa.demoteParticipants(groupJid, jids) : await this.wa.removeParticipants(groupJid, jids);
        log.info({ action, batchNo, attempt, results }, `${action} batch result`);
        return { kind: 'ok', results, attempts: attempt };
      } catch (err) {
        const code = errorStatusCode(err);
        log.warn({ action, batchNo, attempt, code, err: describeError(err) }, `${action} batch request failed`);
        if (code === 401 || code === 403) return { kind: 'fatal', reason: 'permission error' };
        if (code === 404) return { kind: 'fatal', reason: 'group not found' };
        if (!isTransientError(err)) return { kind: 'failed', reason: describeError(err) };
        if (attempt === this.maxBatchAttempts) {
          return { kind: 'failed', reason: `temporary WhatsApp error (${describeError(err)}, after ${attempt} attempts)` };
        }
        const wait = code === 429 ? Math.max(this.rateLimitWaitMs, backoffDelay(attempt, 5000, 120_000)) : backoffDelay(attempt, 2000, 30_000);
        await this.sleep(wait);
      }
    }
    return { kind: 'failed', reason: 'temporary WhatsApp error' };
  }
}

export function formatRemovalReport(report: RemovalReport): string {
  const lines: string[] = [];
  const list = (entries: FailedEntry[]) => entries.map((e) => `- ${e.target.label} — ${e.reason}`);

  if (report.abortedReason) {
    lines.push('Removal aborted', '', `Group: ${report.groupName}`, `Reason: ${report.abortedReason}`);
    return lines.join('\n');
  }

  if (report.dryRun) {
    lines.push('DRY RUN — nobody was removed', '', `Group: ${report.groupName}`, `Would remove: ${report.wouldRemove.length}`);
    if (report.wouldRemove.length > 0) lines.push('', ...report.wouldRemove.map((t) => `${t.index}. ${t.label}`));
    if (report.skipped.length > 0) lines.push('', `Would skip: ${report.skipped.length}`, ...list(report.skipped));
    return lines.join('\n');
  }

  lines.push(report.cancelled ? 'Removal cancelled (partially completed)' : 'Removal completed', '');
  lines.push(`Group: ${report.groupName}`, `Successfully removed: ${report.removed.length}`, `Failed: ${report.failed.length}`);
  if (report.skipped.length > 0) lines.push(`Skipped: ${report.skipped.length}`);
  if (report.notAttempted.length > 0) lines.push(`Not attempted: ${report.notAttempted.length}`);
  if (report.failed.length > 0) lines.push('', 'Failed members:', ...list(report.failed));
  if (report.skipped.length > 0) lines.push('', 'Skipped members:', ...list(report.skipped));
  if (report.notAttempted.length > 0) lines.push('', 'Not attempted:', ...list(report.notAttempted));
  if (report.removed.length > 0 && !report.verified) {
    lines.push('', 'Note: removals were confirmed by WhatsApp, but the follow-up membership check could not be completed.');
  }
  return lines.join('\n');
}

/** One-line progress message sent after each group of a multi-group operation. */
export function formatGroupProgress(report: RemovalReport, index: number, count: number): string {
  const pos = `(${index + 1}/${count})`;
  if (report.abortedReason) return `${report.groupName}: ABORTED — ${report.abortedReason} ${pos}`;
  if (report.dryRun) return `${report.groupName}: would remove ${report.wouldRemove.length} ${pos}`;
  return `${report.groupName}: ${report.removed.length} removed, ${report.failed.length} failed ${pos}`;
}

/** Final report for an operation. A single-group operation uses the single-group format unchanged. */
export function formatOperationReport(op: OperationReport): string {
  if (op.groups.length === 1 && op.groups[0]) return formatRemovalReport(op.groups[0]);

  const sum = (f: (r: RemovalReport) => number) => op.groups.reduce((n, r) => n + f(r), 0);
  const n = op.groups.length;
  const lines: string[] = [];

  const groupLine = (r: RemovalReport) => {
    if (r.abortedReason) return `${r.groupName} — ABORTED: ${r.abortedReason}`;
    if (r.dryRun) return `${r.groupName} — would remove ${r.wouldRemove.length}${r.skipped.length ? `, would skip ${r.skipped.length}` : ''}`;
    const parts = [`removed ${r.removed.length}`, `failed ${r.failed.length}`];
    if (r.skipped.length) parts.push(`skipped ${r.skipped.length}`);
    if (r.notAttempted.length) parts.push(`not attempted ${r.notAttempted.length}`);
    return `${r.groupName} — ${parts.join(', ')}`;
  };

  const byGroup = (title: string, pick: (r: RemovalReport) => FailedEntry[]) => {
    const withEntries = op.groups.filter((r) => pick(r).length > 0);
    if (withEntries.length === 0) return;
    lines.push('', `${title}:`);
    for (const r of withEntries) {
      lines.push(`${r.groupName}:`, ...pick(r).map((e) => `- ${e.target.label} — ${e.reason}`));
    }
  };

  if (op.dryRun) {
    lines.push(`DRY RUN — nobody was removed (${n} groups)`, '', `Total would remove: ${sum((r) => r.wouldRemove.length)}`, '');
    lines.push(...op.groups.map(groupLine));
    byGroup('Would skip', (r) => r.skipped);
    return lines.join('\n');
  }

  lines.push(op.cancelled ? `Removal cancelled — ${n} groups (partially completed)` : `Removal completed — ${n} groups`, '');
  lines.push(`Total removed: ${sum((r) => r.removed.length)}`, `Total failed: ${sum((r) => r.failed.length)}`);
  const skipped = sum((r) => r.skipped.length);
  const notAttempted = sum((r) => r.notAttempted.length);
  if (skipped) lines.push(`Total skipped: ${skipped}`);
  if (notAttempted) lines.push(`Total not attempted: ${notAttempted}`);
  lines.push('', ...op.groups.map(groupLine));
  byGroup('Failed members', (r) => r.failed);
  byGroup('Skipped members', (r) => r.skipped);

  const notAttemptedGroups = op.groups.filter((r) => r.notAttempted.length > 0 && !r.abortedReason);
  if (notAttemptedGroups.length > 0) {
    lines.push('', 'Not attempted:', ...notAttemptedGroups.map((r) => `- ${r.groupName}: ${r.notAttempted.length} member(s) — ${r.notAttempted[0]?.reason}`));
  }
  if (op.groups.some((r) => r.removed.length > 0 && !r.verified)) {
    lines.push('', 'Note: some removals were confirmed by WhatsApp, but the follow-up membership check could not be completed.');
  }
  return lines.join('\n');
}
