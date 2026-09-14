import { IndexSpecError, parseGroupSelection, type GroupSelection } from '../core/parser.js';
import { describeOperation, totalTargets, UserError, type Command, type GroupRemovalPlan, type PendingOperation } from '../core/types.js';

const expiry = (op: PendingOperation) => Math.round((op.expiresAt - op.createdAt) / 1000);

export function formatRemoveAllPreview(op: PendingOperation, prefix: string): string {
  const plan = op.groups[0]!;
  return [
    op.dryRun ? 'WARNING (DRY RUN)' : 'WARNING',
    '',
    `Group: ${plan.groupName}`,
    `Members to remove: ${plan.targets.length}`,
    `Administrators protected: ${plan.protectedAdmins}`,
    '',
    op.dryRun ? 'Dry run: nobody will actually be removed.' : 'This action cannot easily be undone.',
    '',
    'Members:',
    ...plan.targets.map((t) => `${t.index}. ${t.label}`),
    '',
    'Reply:',
    'CONFIRM REMOVEALL',
    '',
    `(or ${prefix}cancel — expires in ${expiry(op)}s)`,
  ].join('\n');
}

export function formatMultiRemoveAllPreview(
  op: PendingOperation,
  emptyGroups: GroupRemovalPlan[],
  usedFreshList: boolean,
  prefix: string,
): string {
  const lines = [
    op.dryRun ? 'WARNING — MULTIPLE GROUPS (DRY RUN)' : 'WARNING — MULTIPLE GROUPS',
    '',
    `Groups: ${op.groups.length}`,
    `Total members to remove: ${totalTargets(op)}`,
    '',
    ...op.groups.map((g) => `${g.groupName} — ${g.targets.length} to remove, ${g.protectedAdmins} admins protected`),
  ];
  if (emptyGroups.length > 0) {
    lines.push('', 'Nothing to remove (skipped):', ...emptyGroups.map((g) => `- ${g.groupName}`));
  }
  lines.push('', op.dryRun ? 'Dry run: nobody will actually be removed.' : 'This action cannot easily be undone.');
  lines.push('Groups are processed one after another.');
  if (usedFreshList) lines.push('', `Note: group numbers are based on the current group list. Send ${prefix}admingroups to review it.`);
  for (const g of op.groups) {
    lines.push('', `${g.groupName}:`, ...g.targets.map((t) => `${t.index}. ${t.label}`));
  }
  lines.push('', 'Reply:', 'CONFIRM REMOVEALL', '', `(or ${prefix}cancel — expires in ${expiry(op)}s)`);
  return lines.join('\n');
}

export const removeAllCommand: Command = {
  name: 'removeall',
  usage: 'removeall <group>[, <group>…]',
  description: 'Preview removal of all non-admin members from one or more groups',
  async execute({ command, services, config, logger }) {
    const p = config.commandPrefix;
    if (!command.args) throw new UserError(`Usage: ${p}removeall <group>\n   or: ${p}removeall 1,3,7\n   or: ${p}removeall Group A | Group B`);
    if (services.removal.getRunning()) throw new UserError('A removal is already running. Wait for it to finish.');
    const pending = services.confirmations.getPending();
    if (pending) {
      throw new UserError(`Another operation is already pending (${describeOperation(pending)}). Confirm it or send ${p}cancel first.`);
    }

    let selection: GroupSelection;
    try {
      selection = parseGroupSelection(command.args);
    } catch (err) {
      if (err instanceof IndexSpecError) throw new UserError(`Invalid group numbers: ${err.message.replace(/member number/gi, 'number')}\nExample: ${p}removeall 1,3,7`);
      throw err;
    }

    const self = services.groups.requireSelf();
    const dryRun = config.dryRun || command.dryRun;

    // Single group: unchanged behaviour.
    if (selection.kind === 'single') {
      const group = await services.groups.resolveAdminGroup(selection.query);
      const s = services.members.selectAllNonAdmins(group, self);
      if (s.targets.length === 0) return `"${group.name}" has no non-admin members to remove.`;
      const op = services.confirmations.create({
        type: 'removeall',
        groups: [{ groupJid: group.jid, groupName: group.name, targets: s.targets, protectedAdmins: s.protectedAdmins }],
        dryRun,
      });
      logger.warn(
        { action: 'removeall.preview', opId: op.id, groupJid: group.jid, groupName: group.name, targetCount: s.targets.length, dryRun },
        'Remove-all preview created',
      );
      return formatRemoveAllPreview(op, p);
    }

    // Several groups.
    const { groups, usedFreshList } = await services.groups.resolveAdminGroups(selection);
    const plans: GroupRemovalPlan[] = groups.map((group) => {
      const s = services.members.selectAllNonAdmins(group, self);
      return { groupJid: group.jid, groupName: group.name, targets: s.targets, protectedAdmins: s.protectedAdmins };
    });
    const withTargets = plans.filter((g) => g.targets.length > 0);
    const empty = plans.filter((g) => g.targets.length === 0);
    if (withTargets.length === 0) {
      return `None of the selected groups has non-admin members to remove:\n${empty.map((g) => `- ${g.groupName}`).join('\n')}`;
    }

    const op = services.confirmations.create({ type: 'removeall', groups: withTargets, dryRun });
    logger.warn(
      {
        action: 'removeall.preview',
        opId: op.id,
        groups: withTargets.map((g) => ({ groupJid: g.groupJid, groupName: g.groupName, targetCount: g.targets.length })),
        targetCount: totalTargets(op),
        dryRun,
      },
      'Multi-group remove-all preview created',
    );
    return formatMultiRemoveAllPreview(op, empty, usedFreshList, p);
  },
};
