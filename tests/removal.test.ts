import { describe, expect, it } from 'vitest';
import type { GroupRemovalPlan, PendingOperation } from '../src/core/types.js';
import { memberLabel } from '../src/services/memberService.js';
import { formatGroupProgress, formatOperationReport, formatRemovalReport, RemovalService } from '../src/services/removalService.js';
import { createNullLogger } from '../src/utils/logger.js';
import { TimeoutError } from '../src/utils/retry.js';
import { FakeWhatsAppClient, lidP, OWNER, pn } from './fakes/fakeWhatsApp.js';

const boom = (statusCode: number) => Object.assign(new Error(`boom ${statusCode}`), { output: { statusCode } });

function bigGroup(n: number) {
  return {
    jid: 'big@g.us',
    name: 'Big Group',
    participants: [
      pn(OWNER, 'Me', 'admin' as const),
      pn('900', 'Admin', 'admin' as const),
      ...Array.from({ length: n }, (_, i) => pn(`91${String(i + 1).padStart(4, '0')}`, `User ${i + 1}`)),
    ],
  };
}

function makePlan(wa: FakeWhatsAppClient, groupJid: string): GroupRemovalPlan {
  const g = wa.groups.get(groupJid)!;
  const targets = g.participants
    .filter((p) => p.role === 'member')
    .map((p, i) => ({ index: i + 1, participant: p, label: memberLabel(p) }));
  return { groupJid, groupName: g.name, targets, protectedAdmins: 2 };
}

function makeOp(wa: FakeWhatsAppClient, groupJids: string | string[], dryRun = false): PendingOperation {
  const jids = Array.isArray(groupJids) ? groupJids : [groupJids];
  return { id: 'op1', type: 'removeall', groups: jids.map((j) => makePlan(wa, j)), dryRun, createdAt: 0, expiresAt: 1 };
}

/** Execute a single-group operation and return that group's report. */
async function exec(svc: RemovalService, op: PendingOperation) {
  return (await svc.execute(op)).groups[0]!;
}

function setup(n = 12, opts: Partial<ConstructorParameters<typeof RemovalService>[2]> = {}) {
  const wa = new FakeWhatsAppClient();
  wa.addGroup(bigGroup(n));
  const sleeps: number[] = [];
  const svc = new RemovalService(wa, createNullLogger(), {
    batchSize: 5,
    batchDelayMs: 3000,
    reconnectWaitMs: 10,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...opts,
  });
  return { wa, svc, sleeps };
}

describe('RemovalService', () => {
  it('removes in batches with delays and reports success', async () => {
    const { wa, svc, sleeps } = setup(12);
    const report = await exec(svc,makeOp(wa, 'big@g.us'));
    expect(wa.removeCalls.map((c) => c.jids.length)).toEqual([5, 5, 2]);
    expect(sleeps).toEqual([3000, 3000]);
    expect(report.removed).toHaveLength(12);
    expect(report.failed).toHaveLength(0);
    expect(report.verified).toBe(true);
    expect(formatRemovalReport(report)).toContain('Successfully removed: 12');
  });

  it('dry run never calls removeParticipants', async () => {
    const { wa, svc } = setup(7);
    const report = await exec(svc,makeOp(wa, 'big@g.us', true));
    expect(wa.removeCalls).toHaveLength(0);
    expect(report.wouldRemove).toHaveLength(7);
    expect(report.removed).toHaveLength(0);
  });

  it('reports partial failures per member', async () => {
    const { wa, svc } = setup(4);
    wa.onRemove = (_g, jids) =>
      jids.map((jid) => ({ jid, status: jid.startsWith('910001') ? '403' : jid.startsWith('910002') ? '406' : '200' }));
    const report = await exec(svc,makeOp(wa, 'big@g.us'));
    expect(report.removed).toHaveLength(2);
    expect(report.failed.map((f) => [f.target.label, f.reason])).toEqual([
      ['User 1 (+910001)', 'permission error'],
      ['User 2 (+910002)', 'not allowed by WhatsApp (e.g. group creator)'],
    ]);
    const text = formatRemovalReport(report);
    expect(text).toContain('Successfully removed: 2');
    expect(text).toContain('Failed: 2');
    expect(text).toContain('- User 1 (+910001) — permission error');
  });

  it('retries members with a transient per-member status once', async () => {
    const { wa, svc } = setup(2);
    let first = true;
    wa.onRemove = (_g, jids) =>
      jids.map((jid) => {
        if (jid.startsWith('910001') && first) {
          first = false;
          return { jid, status: '429' };
        }
        return { jid, status: jid.startsWith('910002') ? '500' : '200' };
      });
    const report = await exec(svc,makeOp(wa, 'big@g.us'));
    expect(report.removed.map((t) => t.label)).toEqual(['User 1 (+910001)']);
    expect(report.failed).toEqual([expect.objectContaining({ reason: 'temporary WhatsApp error' })]);
  });

  it('retries a batch after a rate-limit error with a long wait', async () => {
    const { wa, svc, sleeps } = setup(3);
    wa.onRemove = (_g, jids, call) => {
      if (call === 1) throw boom(429);
      return jids.map((jid) => ({ jid, status: '200' }));
    };
    const report = await exec(svc,makeOp(wa, 'big@g.us'));
    expect(wa.removeCalls).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(30_000);
    expect(report.removed).toHaveLength(3);
  });

  it('marks a batch failed after repeated timeouts but continues with the next batch', async () => {
    const { wa, svc } = setup(7);
    wa.onRemove = (_g, jids, call) => {
      if (call <= 3) throw new TimeoutError('remove', 30000);
      return jids.map((jid) => ({ jid, status: '200' }));
    };
    const report = await exec(svc,makeOp(wa, 'big@g.us'));
    expect(report.failed).toHaveLength(5);
    expect(report.failed[0]?.reason).toContain('temporary WhatsApp error');
    expect(report.removed).toHaveLength(2);
  });

  it('stops on permission error and lists the rest as not attempted', async () => {
    const { wa, svc } = setup(12);
    wa.onRemove = () => {
      throw boom(403);
    };
    const report = await exec(svc,makeOp(wa, 'big@g.us'));
    expect(wa.removeCalls).toHaveLength(1);
    expect(report.failed).toHaveLength(5);
    expect(report.notAttempted).toHaveLength(7);
    expect(report.removed).toHaveLength(0);
  });

  it('reports not-attempted members when the connection is lost', async () => {
    const { wa, svc } = setup(12);
    wa.reconnects = false;
    wa.onRemove = (_g, jids) => {
      wa.status = 'closed';
      return jids.map((jid) => ({ jid, status: '200' }));
    };
    const report = await exec(svc,makeOp(wa, 'big@g.us'));
    expect(report.notAttempted).toHaveLength(7);
    expect(report.notAttempted[0]?.reason).toBe('not attempted (connection lost)');
    // Verification could not run (disconnected): WhatsApp-confirmed removals are still reported, with a note.
    expect(report.removed).toHaveLength(5);
    expect(report.verified).toBe(false);
    expect(formatRemovalReport(report)).toContain('could not be completed');
  });

  it('does not claim removal when WhatsApp says 200 but the member is still present', async () => {
    const { wa, svc } = setup(2);
    const realRemove = wa.removeParticipants.bind(wa);
    wa.removeParticipants = async (g, jids) => {
      await realRemove(g, []);
      return jids.map((jid) => ({ jid, status: '200' }));
    };
    const report = await exec(svc,makeOp(wa, 'big@g.us'));
    expect(report.removed).toHaveLength(0);
    expect(report.failed.every((f) => f.reason.includes('still in the group'))).toBe(true);
  });

  it('does not claim removal when WhatsApp returns no result for a member', async () => {
    const { wa, svc } = setup(2);
    wa.onRemove = (_g, jids) => [{ jid: jids[0]!, status: '200' }];
    const report = await exec(svc,makeOp(wa, 'big@g.us'));
    expect(report.removed).toHaveLength(1);
    expect(report.failed).toEqual([expect.objectContaining({ reason: 'no confirmation from WhatsApp' })]);
  });

  it('matches results addressed by LID', async () => {
    const wa = new FakeWhatsAppClient();
    wa.addGroup({ jid: 'lid@g.us', name: 'LID Group', participants: [pn(OWNER, 'Me', 'admin'), lidP('555', 'Hidden')] });
    const svc = new RemovalService(wa, createNullLogger(), { batchSize: 5, batchDelayMs: 0, sleep: async () => {} });
    const report = await exec(svc,makeOp(wa, 'lid@g.us'));
    expect(report.removed.map((t) => t.label)).toEqual(['Hidden']);
  });

  it('skips targets who became admins or left, and aborts if self lost admin', async () => {
    const { wa, svc } = setup(3);
    const op = makeOp(wa, 'big@g.us');
    const g = wa.groups.get('big@g.us')!;
    g.participants = g.participants.filter((p) => p.name !== 'User 1').map((p) => (p.name === 'User 2' ? { ...p, role: 'admin' as const } : p));
    const report = await exec(svc,op);
    expect(report.removed.map((t) => t.label)).toEqual(['User 3 (+910003)']);
    expect(report.skipped.map((s) => s.reason)).toEqual(['no longer in group', 'is now an administrator (protected)']);

    const { wa: wa2, svc: svc2 } = setup(3);
    const op2 = makeOp(wa2, 'big@g.us');
    const g2 = wa2.groups.get('big@g.us')!;
    g2.participants = g2.participants.map((p) => (p.phoneNumber === OWNER ? { ...p, role: 'member' as const } : p));
    const report2 = await exec(svc2, op2);
    expect(report2.abortedReason).toContain('no longer an administrator');
    expect(wa2.removeCalls).toHaveLength(0);
    expect(formatRemovalReport(report2)).toContain('Removal aborted');
  });

  describe('multiple groups', () => {
    function multiSetup() {
      const { wa, svc, sleeps } = setup(3);
      wa.addGroup({ jid: 'g2@g.us', name: 'Second', participants: [pn(OWNER, 'Me', 'admin'), pn('9201', 'A'), pn('9202', 'B')] });
      wa.addGroup({ jid: 'g3@g.us', name: 'Third', participants: [pn(OWNER, 'Me', 'admin'), pn('9301', 'C')] });
      return { wa, svc, sleeps, op: makeOp(wa, ['big@g.us', 'g2@g.us', 'g3@g.us']) };
    }

    it('processes groups in order, reports progress and totals', async () => {
      const { wa, svc, sleeps, op } = multiSetup();
      const progress: string[] = [];
      const report = await svc.execute(op, { onGroupDone: (r, i, n) => void progress.push(formatGroupProgress(r, i, n)) });
      expect(wa.removeCalls.map((c) => c.groupJid)).toEqual(['big@g.us', 'g2@g.us', 'g3@g.us']);
      expect(progress).toEqual(['Big Group: 3 removed, 0 failed (1/3)', 'Second: 2 removed, 0 failed (2/3)', 'Third: 1 removed, 0 failed (3/3)']);
      expect(sleeps).toEqual([3000, 3000]); // delay between groups
      const text = formatOperationReport(report);
      expect(text).toContain('Removal completed — 3 groups');
      expect(text).toContain('Total removed: 6');
      expect(text).toContain('Total failed: 0');
      expect(text).toContain('Second — removed 2, failed 0');
    });

    it('aborts only the group where admin rights were lost', async () => {
      const { wa, svc, op } = multiSetup();
      const g2 = wa.groups.get('g2@g.us')!;
      g2.participants = g2.participants.map((p) => (p.phoneNumber === OWNER ? { ...p, role: 'member' as const } : p));
      const report = await svc.execute(op);
      expect(report.groups[1]?.abortedReason).toContain('no longer an administrator');
      expect(report.groups[0]?.removed).toHaveLength(3);
      expect(report.groups[2]?.removed).toHaveLength(1);
      expect(wa.removeCalls.map((c) => c.groupJid)).toEqual(['big@g.us', 'g3@g.us']);
      expect(formatOperationReport(report)).toContain('Second — ABORTED: you are no longer an administrator');
    });

    it('reports partial failures grouped by group', async () => {
      const { wa, svc, op } = multiSetup();
      wa.onRemove = (g, jids) => jids.map((jid) => ({ jid, status: g === 'g2@g.us' && jid.startsWith('9201') ? '403' : '200' }));
      const text = formatOperationReport(await svc.execute(op));
      expect(text).toContain('Total removed: 5');
      expect(text).toContain('Total failed: 1');
      expect(text).toMatch(/Failed members:\nSecond:\n- A \(\+9201\) — permission error/);
    });

    it('cancellation stops the remaining groups', async () => {
      const { wa, svc, op } = multiSetup();
      const report = await svc.execute(op, {
        onGroupDone: (_r, i) => {
          if (i === 0) svc.requestCancel();
        },
      });
      expect(wa.removeCalls.map((c) => c.groupJid)).toEqual(['big@g.us']);
      expect(report.cancelled).toBe(true);
      expect(report.groups[1]?.notAttempted[0]?.reason).toBe('not attempted (cancelled)');
      const text = formatOperationReport(report);
      expect(text).toContain('Removal cancelled — 3 groups');
      expect(text).toContain('- Second: 2 member(s) — not attempted (cancelled)');
    });

    it('a lost connection stops the remaining groups', async () => {
      const { wa, svc, op } = multiSetup();
      wa.reconnects = false;
      wa.onRemove = (g, jids) => {
        if (g === 'g2@g.us') wa.status = 'closed';
        return jids.map((jid) => ({ jid, status: '200' }));
      };
      const report = await svc.execute(op);
      expect(wa.removeCalls.map((c) => c.groupJid)).toEqual(['big@g.us', 'g2@g.us']);
      expect(report.groups[2]?.notAttempted[0]?.reason).toBe('not attempted (connection lost)');
      expect(formatOperationReport(report)).toContain('Total not attempted: 1');
    });

    it('exposes group progress while running', async () => {
      const { svc, op } = multiSetup();
      const seen: string[] = [];
      await svc.execute(op, {
        onGroupDone: () => {
          const r = svc.getRunning()!;
          seen.push(`${r.groupIndex + 1}/${r.groupCount}`);
        },
      });
      expect(seen).toEqual(['1/3', '2/3', '3/3']);
    });
  });

  it('rejects a concurrent execution and supports cancellation between batches', async () => {
    const { wa, svc } = setup(12);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    wa.onRemove = async (_g, jids) => {
      await gate;
      return jids.map((jid) => ({ jid, status: '200' }));
    };
    const running = exec(svc, makeOp(wa, 'big@g.us'));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    await expect(svc.execute(makeOp(wa, 'big@g.us'))).rejects.toThrow('already running');
    expect(svc.requestCancel()).toBe(true);
    release();
    const report = await running;
    expect(report.cancelled).toBe(true);
    expect(report.removed).toHaveLength(5);
    expect(report.notAttempted).toHaveLength(7);
    expect(formatRemovalReport(report)).toContain('Removal cancelled');
  });
});
