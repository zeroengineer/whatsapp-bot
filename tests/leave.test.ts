import { describe, expect, it } from 'vitest';
import type { LeaveOperation } from '../src/core/types.js';
import { buildLeavePlan, formatLeaveProgress, formatLeaveReport, LeaveService } from '../src/services/leaveService.js';
import { RemovalService } from '../src/services/removalService.js';
import { createNullLogger } from '../src/utils/logger.js';
import type { GroupInfo } from '../src/whatsapp/client.js';
import { FakeWhatsAppClient, OWNER, pn, SELF } from './fakes/fakeWhatsApp.js';

const me = (role: 'admin' | 'superadmin' | 'member' = 'admin') => pn(OWNER, 'Me', role);

function setup() {
  const wa = new FakeWhatsAppClient();
  const logger = createNullLogger();
  const sleep = async () => {};
  const removal = new RemovalService(wa, logger, { batchSize: 5, batchDelayMs: 0, reconnectWaitMs: 10, sleep });
  const leave = new LeaveService(wa, removal, logger, { batchDelayMs: 0, sleep, leaveNoticeWaitMs: 0 });
  return { wa, removal, leave };
}

function opFor(wa: FakeWhatsAppClient, jids: string[], dryRun = false): LeaveOperation {
  return {
    id: 'op1',
    type: 'leave',
    dryRun,
    createdAt: 0,
    expiresAt: 1,
    groups: jids.map((jid, i) => buildLeavePlan(wa.groups.get(jid)!, i + 1, SELF)),
  };
}

const leftover = (jid: string, name: string, others: GroupInfo['participants'] = []): GroupInfo => ({ jid, name, participants: [me(), ...others] });

describe('buildLeavePlan', () => {
  it('targets other admins but never the creator or you', () => {
    const plan = buildLeavePlan(leftover('a@g.us', 'A', [pn('911', 'Ann', 'admin'), pn('912', 'Raj', 'superadmin')]), 3, SELF);
    expect(plan.selfIsAdmin).toBe(true);
    expect(plan.adminsToRemove.map((t) => t.label)).toEqual(['Ann (+911)']);
    expect(plan.creatorNotRemovable?.label).toBe('Raj (+912)');
  });

  it('does not target anyone in non-admin groups', () => {
    const plan = buildLeavePlan({ jid: 'b@g.us', name: 'B', participants: [me('member'), pn('911', 'Ann', 'admin'), pn('913', 'Bo')] }, 1, SELF);
    expect(plan.selfIsAdmin).toBe(false);
    expect(plan.adminsToRemove).toEqual([]);
  });
});

describe('LeaveService', () => {
  it('demotes, removes, leaves, then deletes the chat — in that order', async () => {
    const { wa, leave } = setup();
    wa.addGroup(leftover('a@g.us', 'Old Project', [pn('911', 'Ann', 'admin'), pn('912', 'Bob', 'admin')]));
    const report = await leave.execute(opFor(wa, ['a@g.us']));
    expect(wa.callLog).toEqual(['demote:a@g.us', 'remove:a@g.us', 'leave:a@g.us', 'delete:a@g.us']);
    const g = report.groups[0]!;
    expect(g.adminsRemoved).toHaveLength(2);
    expect(g.left).toBe(true);
    expect(g.chatDeleted).toBe(true);
    const text = formatLeaveReport(report);
    expect(text).toContain('Leave completed — 1 group');
    expect(text).toContain('Left: 1 · Chats deleted: 1 · Failed: 0');
    expect(text).toContain('Old Project — removed 2 admin(s), left, chat deleted');
  });

  it('leaves a non-admin group without touching members', async () => {
    const { wa, leave } = setup();
    wa.addGroup({ jid: 'b@g.us', name: 'Family', participants: [me('member'), pn('911', 'Ann', 'admin'), pn('913', 'Bo')] });
    const report = await leave.execute(opFor(wa, ['b@g.us']));
    expect(wa.callLog).toEqual(['leave:b@g.us', 'delete:b@g.us']);
    expect(report.groups[0]?.chatDeleted).toBe(true);
  });

  it('reports the creator as not removable and still leaves', async () => {
    const { wa, leave } = setup();
    wa.addGroup(leftover('a@g.us', 'Trip', [pn('912', 'Raj', 'superadmin')]));
    const report = await leave.execute(opFor(wa, ['a@g.us']));
    expect(wa.demoteCalls).toHaveLength(0);
    expect(report.groups[0]?.left).toBe(true);
    expect(formatLeaveReport(report)).toContain("Admins not removed:\nTrip:\n- Raj (+912) — group creator can't be removed");
  });

  it('reports failed demotes and does not try to remove those admins', async () => {
    const { wa, leave } = setup();
    wa.addGroup(leftover('a@g.us', 'A', [pn('911', 'Ann', 'admin'), pn('912', 'Bob', 'admin')]));
    wa.onDemote = (_g, jids) => jids.map((jid) => ({ jid, status: jid.startsWith('911') ? '403' : '200' }));
    const report = await leave.execute(opFor(wa, ['a@g.us']));
    expect(wa.removeCalls[0]?.jids).toEqual(['912@s.whatsapp.net']);
    expect(report.groups[0]?.adminsFailed.map((f) => f.reason)).toEqual(['demote failed: permission error']);
    expect(report.groups[0]?.left).toBe(true);
  });

  it('does not delete the chat when the leave is not confirmed', async () => {
    const { wa, leave } = setup();
    wa.addGroup(leftover('a@g.us', 'A'));
    wa.onLeave = () => {}; // WhatsApp accepted, but we are still a member
    const report = await leave.execute(opFor(wa, ['a@g.us']));
    expect(report.groups[0]?.left).toBe(false);
    expect(report.groups[0]?.error).toContain('leave not confirmed');
    expect(wa.deleteChatCalls).toHaveLength(0);
  });

  it('reports a failed chat delete after leaving', async () => {
    const { wa, leave } = setup();
    wa.addGroup(leftover('a@g.us', 'A'));
    wa.onDeleteChat = () => {
      throw Object.assign(new Error('bad'), { output: { statusCode: 400 } });
    };
    const report = await leave.execute(opFor(wa, ['a@g.us']));
    expect(report.groups[0]?.left).toBe(true);
    expect(report.groups[0]?.chatDeleted).toBe(false);
    expect(formatLeaveReport(report)).toContain('A — left, chat delete FAILED (WhatsApp error 400): delete it manually');
  });

  it('re-check skips groups that gained regular members or whose chat is no longer deletable', async () => {
    const { wa, leave } = setup();
    wa.addGroup(leftover('a@g.us', 'Gained'));
    wa.addGroup(leftover('b@g.us', 'Undeletable'));
    const op = opFor(wa, ['a@g.us', 'b@g.us']);
    wa.groups.get('a@g.us')!.participants.push(pn('999', 'New'));
    wa.deletableChats.delete('b@g.us');
    const report = await leave.execute(op);
    expect(wa.leaveCalls).toHaveLength(0);
    expect(report.groups[0]?.skippedReason).toContain('regular members joined');
    expect(report.groups[1]?.skippedReason).toContain("chat can't be deleted");
  });

  it('dry run sends no demote/remove/leave/delete requests', async () => {
    const { wa, leave } = setup();
    wa.addGroup(leftover('a@g.us', 'A', [pn('911', 'Ann', 'admin')]));
    const report = await leave.execute(opFor(wa, ['a@g.us'], true));
    expect(wa.callLog).toEqual([]);
    expect(formatLeaveReport(report)).toContain('A — would demote & remove 1 admin(s), would leave, would delete chat');
  });

  it('cancellation between groups leaves the rest untouched', async () => {
    const { wa, leave, removal } = setup();
    wa.addGroup(leftover('a@g.us', 'A'));
    wa.addGroup(leftover('b@g.us', 'B'));
    const progress: string[] = [];
    const report = await leave.execute(opFor(wa, ['a@g.us', 'b@g.us']), {
      onGroupDone: (r, i, n) => {
        progress.push(formatLeaveProgress(r, i, n));
        removal.requestCancel();
      },
    });
    expect(wa.leaveCalls).toEqual(['a@g.us']);
    expect(progress).toEqual(['A — left, chat deleted (1/2)']);
    expect(report.cancelled).toBe(true);
    expect(report.groups[1]?.skippedReason).toBe('not attempted (cancelled)');
  });

  it('a lost connection stops the remaining groups', async () => {
    const { wa, leave } = setup();
    wa.reconnects = false;
    wa.addGroup(leftover('a@g.us', 'A'));
    wa.addGroup(leftover('b@g.us', 'B'));
    wa.onDeleteChat = () => {
      wa.status = 'closed';
    };
    const report = await leave.execute(opFor(wa, ['a@g.us', 'b@g.us']));
    expect(report.groups[0]?.chatDeleted).toBe(true);
    expect(report.groups[1]?.skippedReason).toBe('not attempted (connection lost)');
    expect(wa.leaveCalls).toEqual(['a@g.us']);
  });

  it('shares the lock with removals', async () => {
    const { wa, leave, removal } = setup();
    wa.addGroup(leftover('a@g.us', 'A'));
    let release!: () => void;
    wa.onLeave = (g) =>
      new Promise<void>((r) => {
        release = () => {
          wa.leftGroups.add(g);
          r();
        };
      });
    const running = leave.execute(opFor(wa, ['a@g.us']));
    await new Promise((r) => setTimeout(r, 0));
    expect(removal.getRunning()?.kind).toBe('leave');
    await expect(
      removal.execute({ id: 'x', type: 'removeall', groups: [{ groupJid: 'a@g.us', groupName: 'A', targets: [], protectedAdmins: 0 }], dryRun: false, createdAt: 0, expiresAt: 1 }),
    ).rejects.toThrow('A leave operation is already running');
    release();
    await running;
    expect(removal.getRunning()).toBeUndefined();
  });
});
