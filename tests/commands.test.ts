import { describe, expect, it } from 'vitest';
import { collegeGroup, createHarness, OWNER, pn } from './fakes/fakeWhatsApp.js';

function setup() {
  const h = createHarness();
  h.wa.addGroup(collegeGroup());
  h.wa.addGroup({ jid: 'volunteers@g.us', name: 'Event Volunteers', participants: [pn(OWNER, 'Me', 'member'), pn('912', 'Zed')] });
  h.wa.addGroup({ jid: 'project@g.us', name: 'Project Team', participants: [pn(OWNER, 'Me', 'admin'), pn('913', 'Pat')] });
  return h;
}

describe('!groups', () => {
  it('lists groups sorted with admin markers', async () => {
    const h = setup();
    const reply = await h.say('!groups');
    expect(reply).toContain('Your WhatsApp Groups');
    expect(reply).toMatch(/1\. College Group \[ADMIN\]\n2\. Event Volunteers\n3\. Project Team \[ADMIN\]/);
    expect(reply).toContain('admin in 2 of 3');
  });
});

describe('!members', () => {
  it('lists members with stable numbering and admin markers', async () => {
    const h = setup();
    const reply = await h.say('!members College Group');
    expect(reply).toContain('College Group');
    // Sorted by name: Akhil, Arun, John, Me, Neha, Rahul
    expect(reply).toMatch(/1\. Akhil \(\+911000000002\) \[ADMIN\]/);
    expect(reply).toMatch(/2\. Arun \(\+911000000004\)\n/);
    expect(reply).toMatch(/3\. John \(\+911000000005\) \[OWNER\]/);
    expect(reply).toMatch(/4\. Me \(\+919999999999\) \[ADMIN\] \[YOU\]/);
    expect(reply).toContain('Members: 6 · Admins: 3');
  });

  it('resolves group by number from !groups and by partial name', async () => {
    const h = setup();
    await h.say('!groups');
    expect(await h.say('!members 3')).toContain('Project Team');
    expect(await h.say('!members college')).toContain('College Group');
  });

  it('rejects an invalid group', async () => {
    const h = setup();
    expect(await h.say('!members Nonexistent')).toContain('not found');
    await h.say('!groups');
    expect(await h.say('!members 99')).toContain('not found');
  });

  it('rejects groups where the account is not admin', async () => {
    const h = setup();
    expect(await h.say('!members Event Volunteers')).toContain('not an administrator');
  });

  it('reports ambiguous names', async () => {
    const h = setup();
    h.wa.addGroup({ jid: 'college2@g.us', name: 'College Alumni', participants: [pn(OWNER, 'Me', 'admin')] });
    const reply = await h.say('!members college');
    expect(reply).toContain('More than one group matches');
  });
});

describe('!remove preview', () => {
  it('shows the preview and protects admins', async () => {
    const h = setup();
    await h.say('!members College Group');
    const reply = await h.say('!remove College Group 2,5,6');
    expect(reply).toContain('Removal Preview');
    expect(reply).toContain('Group: College Group');
    expect(reply).toContain('Members to remove: 3');
    expect(reply).toContain('2. Arun');
    expect(reply).toContain('5. Neha');
    expect(reply).toContain('6. Rahul');
    expect(reply).toContain('Admins protected: 3');
    expect(reply).toMatch(/Reply with:\nCONFIRM/);
    expect(h.wa.removeCalls).toHaveLength(0);
  });

  it('skips selected admins and the owner', async () => {
    const h = setup();
    await h.say('!members College Group');
    const reply = await h.say('!remove College Group 1,2,4');
    expect(reply).toContain('Members to remove: 1');
    expect(reply).toContain('skipped:\n1. Akhil');
    expect(reply).toContain('4. Me');
    const pending = h.services.confirmations.getPending();
    expect(pending?.type).toBe('remove');
    expect(pending?.type === 'remove' && pending.groups[0]?.targets.map((t) => t.label)).toEqual(['Arun (+911000000004)']);
  });

  it('refuses when only admins are selected', async () => {
    const h = setup();
    await h.say('!members College Group');
    expect(await h.say('!remove College Group 1,3')).toContain('Nothing to remove');
    expect(h.services.confirmations.getPending()).toBeUndefined();
  });

  it('rejects invalid member indexes', async () => {
    const h = setup();
    await h.say('!members College Group');
    expect(await h.say('!remove College Group 2,40')).toContain('Invalid member number(s): 40');
    expect(await h.say('!remove College Group 0')).toContain('Invalid member number');
    expect(h.services.confirmations.getPending()).toBeUndefined();
  });

  it('rejects the selection if a listed member has left since !members', async () => {
    const h = setup();
    await h.say('!members College Group');
    const g = h.wa.groups.get('college@g.us')!;
    g.participants = g.participants.filter((p) => p.name !== 'Arun');
    expect(await h.say('!remove College Group 2')).toContain('no longer in "College Group"');
  });

  it('uses the fresh list and says so when !members was not run', async () => {
    const h = setup();
    const reply = await h.say('!remove College Group 2');
    expect(reply).toContain('2. Arun');
    expect(reply).toContain('numbers are based on the current member list');
  });

  it('handles group names ending in numbers', async () => {
    const h = setup();
    h.wa.addGroup({ jid: 'batch@g.us', name: 'Batch 2024', participants: [pn(OWNER, 'Me', 'admin'), pn('914', 'Kim')] });
    // Sorted: 1. Kim, 2. Me — "2024" must be treated as part of the name, "1" as the index.
    const reply = await h.say('!remove Batch 2024 1');
    expect(reply).toContain('Group: Batch 2024');
    expect(reply).toContain('1. Kim');
  });

  it('blocks a second destructive command while one is pending', async () => {
    const h = setup();
    await h.say('!remove College Group 2');
    expect(await h.say('!removeall Project Team')).toContain('already pending');
    expect(h.services.confirmations.getPending()?.groups[0]?.groupName).toBe('College Group');
  });
});

describe('!removeall preview', () => {
  it('shows the warning with counts', async () => {
    const h = setup();
    const reply = await h.say('!removeall College Group');
    expect(reply).toContain('WARNING');
    expect(reply).toContain('Members to remove: 3');
    expect(reply).toContain('Administrators protected: 3');
    expect(reply).toContain('This action cannot easily be undone.');
    expect(reply).toMatch(/Reply:\nCONFIRM REMOVEALL/);
  });
});

describe('!admingroups', () => {
  it('lists only admin groups, keeping the !groups numbers', async () => {
    const h = setup();
    const reply = await h.say('!admingroups');
    expect(reply).toContain('Groups You Admin');
    expect(reply).toMatch(/1\. College Group\n3\. Project Team\n/);
    expect(reply).not.toContain('Event Volunteers');
    expect(reply).toContain('admin in 2 of 3 groups');
    expect(reply).toContain('!removeall 1,3');
  });

  it('its numbers work with other commands', async () => {
    const h = setup();
    await h.say('!admingroups');
    expect(await h.say('!members 3')).toContain('Project Team');
  });

  it('handles having no admin groups', async () => {
    const h = createHarness();
    h.wa.addGroup({ jid: 'x@g.us', name: 'X', participants: [pn(OWNER, 'Me'), pn('1', 'A')] });
    expect(await h.say('!admingroups')).toContain('not an admin in any');
  });
});

describe('!removeall with multiple groups', () => {
  function multiSetup() {
    const h = setup();
    h.wa.addGroup({ jid: 'sports@g.us', name: 'Sports Club', participants: [pn(OWNER, 'Me', 'admin'), pn('915', 'Sam'), pn('916', 'Lee', 'admin')] });
    h.wa.addGroup({ jid: 'empty@g.us', name: 'Admins Only', participants: [pn(OWNER, 'Me', 'admin'), pn('917', 'Ann', 'admin')] });
    // Sorted: 1 Admins Only, 2 College Group, 3 Event Volunteers, 4 Project Team, 5 Sports Club
    return h;
  }

  it('previews several groups by number with per-group counts, names and totals', async () => {
    const h = multiSetup();
    await h.say('!admingroups');
    const reply = await h.say('!removeall 2,4,5');
    expect(reply).toContain('WARNING — MULTIPLE GROUPS');
    expect(reply).toContain('Groups: 3');
    expect(reply).toContain('Total members to remove: 5');
    expect(reply).toContain('College Group — 3 to remove, 3 admins protected');
    expect(reply).toContain('Project Team — 1 to remove, 1 admins protected');
    expect(reply).toContain('Sports Club — 1 to remove, 2 admins protected');
    expect(reply).toMatch(/Project Team:\n2\. Pat/);
    expect(reply).toMatch(/Reply:\nCONFIRM REMOVEALL/);
    expect(h.services.confirmations.getPending()?.groups).toHaveLength(3);
    expect(h.wa.removeCalls).toHaveLength(0);
  });

  it('accepts group names separated by |', async () => {
    const h = multiSetup();
    const reply = await h.say('!removeall College Group | Sports Club');
    expect(reply).toContain('Groups: 2');
    expect(reply).toContain('Total members to remove: 4');
    expect(reply).toContain('group numbers are based on the current group list');
  });

  it('rejects the whole selection if any group is not admin', async () => {
    const h = multiSetup();
    await h.say('!groups');
    const reply = await h.say('!removeall 2,3');
    expect(reply).toContain('not an administrator of:\n- Event Volunteers');
    expect(reply).toContain('Nothing was queued');
    expect(h.services.confirmations.getPending()).toBeUndefined();
  });

  it('rejects out-of-range numbers and unknown or ambiguous names', async () => {
    const h = multiSetup();
    await h.say('!groups');
    expect(await h.say('!removeall 2,9')).toContain('Group number 9 does not exist');
    expect(await h.say('!removeall College Group | Nope')).toContain('Group "Nope" not found');
    expect(await h.say('!removeall Club | o')).toContain('"o" matches several groups');
    expect(await h.say('!removeall 0,2')).toContain('Invalid group numbers');
    expect(h.services.confirmations.getPending()).toBeUndefined();
  });

  it('rejects more than 20 groups', async () => {
    const h = createHarness();
    for (let i = 1; i <= 21; i++) {
      h.wa.addGroup({ jid: `g${i}@g.us`, name: `Group ${String(i).padStart(2, '0')}`, participants: [pn(OWNER, 'Me', 'admin'), pn(`9${i}`, 'X')] });
    }
    await h.say('!groups');
    expect(await h.say('!removeall 1-21')).toContain('Too many groups selected (21)');
    expect(h.services.confirmations.getPending()).toBeUndefined();
  });

  it('counts duplicate groups once', async () => {
    const h = multiSetup();
    await h.say('!groups');
    const reply = await h.say('!removeall College Group | college group | Sports Club');
    expect(reply).toContain('Groups: 2');
  });

  it('lists groups with nothing to remove and skips them', async () => {
    const h = multiSetup();
    await h.say('!groups');
    const reply = await h.say('!removeall 1,4');
    expect(reply).toContain('Groups: 1');
    expect(reply).toContain('Nothing to remove (skipped):\n- Admins Only');
    expect(h.services.confirmations.getPending()?.groups.map((g) => g.groupName)).toEqual(['Project Team']);

    const h2 = multiSetup();
    await h2.say('!groups');
    h2.wa.groups.get('project@g.us')!.participants = [pn(OWNER, 'Me', 'admin')];
    expect(await h2.say('!removeall 1,4')).toContain('None of the selected groups has non-admin members');
    expect(h2.services.confirmations.getPending()).toBeUndefined();
  });

  it('is blocked while another operation is pending', async () => {
    const h = multiSetup();
    await h.say('!remove College Group 2');
    expect(await h.say('!removeall 2,4')).toContain('already pending');
  });

  it('shows multi-group pending operations in !status', async () => {
    const h = multiSetup();
    await h.say('!removeall 2,4');
    expect(await h.say('!status')).toContain('Pending operation: removeall in 2 groups (4 members)');
  });
});

describe('!emptygroups / !nonadmingroups / !leave', () => {
  function leaveSetup() {
    const h = createHarness();
    // Sorted by name: 1 Active Club, 2 Empty Solo, 3 Family Chat, 4 Old Admins, 5 Silent Group
    h.wa.addGroup({ jid: 'active@g.us', name: 'Active Club', participants: [pn(OWNER, 'Me', 'admin'), pn('911', 'Reg')] });
    h.wa.addGroup({ jid: 'solo@g.us', name: 'Empty Solo', participants: [pn(OWNER, 'Me', 'admin')] });
    h.wa.addGroup({ jid: 'family@g.us', name: 'Family Chat', participants: [pn(OWNER, 'Me'), pn('912', 'Mom', 'admin'), pn('913', 'Bro')] });
    h.wa.addGroup({
      jid: 'old@g.us',
      name: 'Old Admins',
      participants: [pn(OWNER, 'Me', 'admin'), pn('914', 'Ann', 'admin'), pn('915', 'Raj', 'superadmin')],
    });
    h.wa.addGroup({ jid: 'silent@g.us', name: 'Silent Group', participants: [pn(OWNER, 'Me', 'admin'), pn('916', 'Zed', 'admin')] }, { deletable: false });
    return h;
  }

  it('!emptygroups lists admin groups with no regular members, keeping !groups numbers', async () => {
    const h = leaveSetup();
    const reply = await h.say('!emptygroups');
    expect(reply).toContain('Groups With No Regular Members');
    expect(reply).toContain('2. Empty Solo — only you');
    expect(reply).toContain("4. Old Admins — you + 2 admins (creator can't be removed)");
    expect(reply).toContain("5. Silent Group — you + 1 admin [chat can't be deleted]");
    expect(reply).not.toContain('Active Club');
    expect(reply).not.toContain('Family Chat');
    expect(reply).toContain('!leave 2,4');
  });

  it('!nonadmingroups lists groups where you are not admin', async () => {
    const h = leaveSetup();
    const reply = await h.say('!nonadmingroups');
    expect(reply).toContain('3. Family Chat — 3 members');
    expect(reply).not.toContain('Empty Solo');
  });

  it('!leave all previews the last list, skipping undeletable chats', async () => {
    const h = leaveSetup();
    await h.say('!emptygroups');
    const reply = await h.say('!leave all');
    expect(reply).toContain('Leave Preview');
    expect(reply).toContain('Groups: 2');
    expect(reply).toContain('2. Empty Solo [ADMIN] — leave, delete chat');
    expect(reply).toContain('4. Old Admins [ADMIN] — demote & remove 1 admin, leave, delete chat');
    expect(reply).toContain('   - Ann (+914)');
    expect(reply).toContain("Raj (+915) is the group creator and can't be removed (will remain)");
    expect(reply).toContain("Skipped (chat can't be deleted — no known messages):\n- Silent Group");
    expect(reply).toMatch(/Reply:\nCONFIRM LEAVE/);
    expect(h.services.confirmations.getPending()?.type).toBe('leave');
  });

  it('!leave by numbers can mix non-admin and leftover groups', async () => {
    const h = leaveSetup();
    await h.say('!groups');
    const reply = await h.say('!leave 2,3');
    expect(reply).toContain('Groups: 2');
    expect(reply).toContain('3. Family Chat — leave, delete chat');
  });

  it('rejects admin groups that still have regular members', async () => {
    const h = leaveSetup();
    await h.say('!groups');
    const reply = await h.say('!leave 1,2');
    expect(reply).toContain('still have regular members — use !removeall first:\n- Active Club');
    expect(h.services.confirmations.getPending()).toBeUndefined();
  });

  it('rejects !leave all without a recent list, bad numbers and too many groups', async () => {
    const h = leaveSetup();
    expect(await h.say('!leave all')).toContain('Send !emptygroups or !nonadmingroups first');
    await h.say('!emptygroups');
    h.advance(11 * 60_000);
    h.state.startedAt = h.now();
    expect(await h.say('!leave all')).toContain('Send !emptygroups or !nonadmingroups first');
    await h.say('!groups');
    expect(await h.say('!leave 9')).toContain('Group number(s) 9 do not exist');
    expect(await h.say('!leave abc')).toContain('Usage: !leave');

    const big = createHarness();
    for (let i = 1; i <= 21; i++) big.wa.addGroup({ jid: `g${i}@g.us`, name: `G${String(i).padStart(2, '0')}`, participants: [pn(OWNER, 'Me', 'admin')] });
    await big.say('!groups');
    expect(await big.say('!leave 1-21')).toContain('Too many groups selected (21)');
  });

  it('refuses when every selected chat is undeletable', async () => {
    const h = leaveSetup();
    await h.say('!groups');
    expect(await h.say('!leave 5')).toContain("Nothing to leave: none of the selected groups' chats can be deleted");
    expect(h.services.confirmations.getPending()).toBeUndefined();
  });

  it('is blocked while another operation is pending', async () => {
    const h = leaveSetup();
    await h.say('!groups');
    await h.say('!removeall 1');
    expect(await h.say('!leave 2')).toContain('already pending');
  });
});

describe('!status', () => {
  it('shows status details without secrets', async () => {
    const h = setup();
    await h.say('!help');
    const reply = await h.say('!status');
    expect(reply).toContain('WhatsApp: open');
    expect(reply).toContain(`Account: +${OWNER}`);
    expect(reply).toContain('Groups: 3');
    expect(reply).toContain('Last command: !help');
    expect(reply).toContain('Pending operation: none');
  });
});
