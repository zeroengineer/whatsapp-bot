import { describe, expect, it } from 'vitest';
import { ConfirmationService } from '../src/services/confirmationService.js';
import { collegeGroup, createHarness, OWNER, pn } from './fakes/fakeWhatsApp.js';

function setup(config = {}) {
  const h = createHarness({ config });
  h.wa.addGroup(collegeGroup());
  return h;
}

describe('confirmation flow', () => {
  it('executes only after CONFIRM', async () => {
    const h = setup();
    await h.say('!members College Group');
    await h.say('!remove College Group 2,5');
    expect(h.wa.removeCalls).toHaveLength(0);

    h.advance(1000);
    const reply = await h.say('CONFIRM');
    expect(h.wa.removeCalls).toHaveLength(1);
    expect(reply).toContain('Removing 2 member(s)');
    expect(reply).toContain('Removal completed');
    expect(reply).toContain('Successfully removed: 2');
    expect(reply).toContain('Failed: 0');
  });

  it('a repeated CONFIRM does nothing', async () => {
    const h = setup();
    await h.say('!remove College Group 2');
    await h.say('CONFIRM');
    const second = await h.say('CONFIRM');
    expect(second).toBe('Nothing to confirm.');
    expect(h.wa.removeCalls).toHaveLength(1);
  });

  it('CONFIRM with nothing pending does nothing', async () => {
    const h = setup();
    expect(await h.say('CONFIRM')).toBe('Nothing to confirm.');
    expect(h.wa.removeCalls).toHaveLength(0);
  });

  it('requires the matching token for removeall', async () => {
    const h = setup();
    await h.say('!removeall College Group');
    expect(await h.say('CONFIRM')).toContain('CONFIRM REMOVEALL');
    expect(h.wa.removeCalls).toHaveLength(0);
    // Still pending after a wrong token.
    const reply = await h.say('CONFIRM REMOVEALL');
    expect(reply).toContain('Successfully removed: 3');
  });

  it('CONFIRM REMOVEALL does not confirm a plain remove', async () => {
    const h = setup();
    await h.say('!remove College Group 2');
    expect(await h.say('CONFIRM REMOVEALL')).toContain('needs the reply:\nCONFIRM');
    expect(h.wa.removeCalls).toHaveLength(0);
  });

  it('rejects an expired confirmation', async () => {
    const h = setup();
    await h.say('!remove College Group 2');
    h.advance(121_000);
    h.state.startedAt = h.now(); // keep the message "fresh" for the router
    expect(await h.say('CONFIRM')).toContain('expired');
    expect(h.wa.removeCalls).toHaveLength(0);
    expect(h.services.confirmations.getPending()).toBeUndefined();
  });

  it('rejects a CONFIRM message older than the preview', () => {
    let t = 10_000_000;
    const svc = new ConfirmationService(60_000, () => t);
    svc.create({ type: 'remove', groups: [{ groupJid: 'g', groupName: 'G', targets: [], protectedAdmins: 0 }], dryRun: false });
    t += 3000;
    expect(svc.consume('CONFIRM', 10_000_000 - 2000)).toEqual({ ok: false, reason: 'stale' });
    expect(svc.consume('CONFIRM', t)).toMatchObject({ ok: true });
  });

  it('!cancel discards the pending operation', async () => {
    const h = setup();
    await h.say('!remove College Group 2');
    expect(await h.say('!cancel')).toContain('Cancelled: remove in "College Group"');
    expect(await h.say('CONFIRM')).toBe('Nothing to confirm.');
    expect(h.wa.removeCalls).toHaveLength(0);
  });

  it('!cancel with nothing pending', async () => {
    const h = setup();
    expect(await h.say('!cancel')).toBe('There is no pending operation.');
  });
});

describe('multi-group confirmation', () => {
  function multi(config = {}) {
    const h = setup(config);
    h.wa.addGroup({ jid: 'project@g.us', name: 'Project Team', participants: [pn(OWNER, 'Me', 'admin'), pn('913', 'Pat'), pn('914', 'Sam')] });
    return h;
  }

  it('CONFIRM REMOVEALL removes from every group with progress messages', async () => {
    const h = multi();
    await h.say('!removeall 1,2');
    const reply = await h.say('CONFIRM REMOVEALL');
    expect(reply).toContain('Removing 5 member(s) from 2 groups');
    expect(reply).toContain('College Group: 3 removed, 0 failed (1/2)');
    expect(reply).toContain('Project Team: 2 removed, 0 failed (2/2)');
    expect(reply).toContain('Removal completed — 2 groups');
    expect(reply).toContain('Total removed: 5');
    expect(h.wa.removeCalls.map((c) => c.groupJid)).toEqual(['college@g.us', 'project@g.us']);
  });

  it('plain CONFIRM does not run a multi-group removeall', async () => {
    const h = multi();
    await h.say('!removeall 1,2');
    expect(await h.say('CONFIRM')).toContain('CONFIRM REMOVEALL');
    expect(h.wa.removeCalls).toHaveLength(0);
  });

  it('dry run removes nobody in any group', async () => {
    const h = multi();
    await h.say('!removeall 1,2 --dry-run');
    const reply = await h.say('CONFIRM REMOVEALL');
    expect(reply).toContain('DRY RUN — nobody was removed (2 groups)');
    expect(reply).toContain('Total would remove: 5');
    expect(reply).toContain('College Group — would remove 3');
    expect(h.wa.removeCalls).toHaveLength(0);
  });
});

describe('leave confirmation', () => {
  function leaveSetup(config = {}) {
    const h = createHarness({ config });
    h.wa.addGroup({ jid: 'old@g.us', name: 'Old', participants: [pn(OWNER, 'Me', 'admin'), pn('914', 'Ann', 'admin')] });
    h.wa.addGroup({ jid: 'fam@g.us', name: 'Fam', participants: [pn(OWNER, 'Me'), pn('913', 'Bro')] });
    return h;
  }

  it('requires CONFIRM LEAVE and then runs with progress', async () => {
    const h = leaveSetup();
    await h.say('!groups'); // 1 Fam, 2 Old
    await h.say('!leave 1,2');
    expect(await h.say('CONFIRM')).toContain('CONFIRM LEAVE');
    expect(await h.say('CONFIRM REMOVEALL')).toContain('CONFIRM LEAVE');
    expect(h.wa.callLog).toEqual([]);

    const reply = await h.say('CONFIRM LEAVE');
    expect(reply).toContain('Leaving 2 group(s) and deleting their chats');
    expect(reply).toContain('Fam — left, chat deleted (1/2)');
    expect(reply).toContain('Old — removed 1 admin(s), left, chat deleted (2/2)');
    expect(reply).toContain('Left: 2 · Chats deleted: 2 · Failed: 0');
    expect(h.wa.callLog).toEqual(['leave:fam@g.us', 'delete:fam@g.us', 'demote:old@g.us', 'remove:old@g.us', 'leave:old@g.us', 'delete:old@g.us']);
  });

  it('expires like other operations', async () => {
    const h = leaveSetup();
    await h.say('!groups');
    await h.say('!leave 1');
    h.advance(121_000);
    h.state.startedAt = h.now();
    expect(await h.say('CONFIRM LEAVE')).toContain('expired');
    expect(h.wa.leaveCalls).toHaveLength(0);
  });

  it('dry run changes nothing', async () => {
    const h = leaveSetup({ dryRun: true });
    await h.say('!groups');
    const preview = await h.say('!leave 1,2');
    expect(preview).toContain('Leave Preview (DRY RUN)');
    const reply = await h.say('CONFIRM LEAVE');
    expect(reply).toContain('DRY RUN — nothing was changed (2 groups)');
    expect(h.wa.callLog).toEqual([]);
  });
});

describe('dry-run mode', () => {
  it('--dry-run flag previews and confirms but never removes', async () => {
    const h = setup();
    const preview = await h.say('!remove College Group 2,5 --dry-run');
    expect(preview).toContain('Removal Preview (DRY RUN)');
    const reply = await h.say('CONFIRM');
    expect(reply).toContain('DRY RUN — nobody was removed');
    expect(reply).toContain('Would remove: 2');
    expect(h.wa.removeCalls).toHaveLength(0);
    expect(h.wa.groups.get('college@g.us')!.participants).toHaveLength(6);
  });

  it('DRY_RUN config applies to every operation', async () => {
    const h = setup({ dryRun: true });
    await h.say('!removeall College Group');
    const reply = await h.say('CONFIRM REMOVEALL');
    expect(reply).toContain('DRY RUN');
    expect(h.wa.removeCalls).toHaveLength(0);
  });
});
