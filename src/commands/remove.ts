import { describeOperation, UserError, type Command, type PendingOperation } from '../core/types.js';
import type { MemberEntry } from '../services/memberService.js';

export function formatRemovePreview(op: PendingOperation, excluded: MemberEntry[], usedFreshList: boolean, prefix: string): string {
  const plan = op.groups[0]!;
  const lines = [
    op.dryRun ? 'Removal Preview (DRY RUN)' : 'Removal Preview',
    '',
    `Group: ${plan.groupName}`,
    `Members to remove: ${plan.targets.length}`,
    '',
    ...plan.targets.map((t) => `${t.index}. ${t.label}`),
    '',
    `Admins protected: ${plan.protectedAdmins}`,
  ];
  if (excluded.length > 0) {
    lines.push('', 'Not removable (admin or your account), skipped:', ...excluded.map((e) => `${e.index}. ${e.label}`));
  }
  if (usedFreshList) {
    lines.push('', `Note: numbers are based on the current member list. Send ${prefix}members to review it.`);
  }
  lines.push('', 'Reply with:', 'CONFIRM', '', `(or ${prefix}cancel — expires in ${Math.round((op.expiresAt - op.createdAt) / 1000)}s)`);
  return lines.join('\n');
}

export const removeCommand: Command = {
  name: 'remove',
  usage: 'remove <group> <member numbers>',
  description: 'Preview removal of selected members',
  async execute({ command, services, config, logger }) {
    if (!command.args) throw new UserError(`Usage: ${config.commandPrefix}remove <group> <member numbers>\nExample: ${config.commandPrefix}remove College Group 1,3,4`);
    if (services.removal.getRunning()) throw new UserError('A removal is already running. Wait for it to finish.');
    const pending = services.confirmations.getPending();
    if (pending) {
      throw new UserError(`Another operation is already pending (${describeOperation(pending)}). Confirm it or send ${config.commandPrefix}cancel first.`);
    }

    const self = services.groups.requireSelf();
    const { group, indexSpec } = await services.groups.resolveWithIndexes(command.args);
    const selection = services.members.select(group, self, indexSpec);

    if (selection.targets.length === 0) {
      throw new UserError(
        `Nothing to remove: every selected member is an administrator or your own account.\nAdmins are always protected.`,
      );
    }

    const op = services.confirmations.create({
      type: 'remove',
      groups: [{ groupJid: group.jid, groupName: group.name, targets: selection.targets, protectedAdmins: selection.protectedAdmins }],
      dryRun: config.dryRun || command.dryRun,
    });
    logger.info(
      { action: 'remove.preview', opId: op.id, groupJid: group.jid, groupName: group.name, targetCount: selection.targets.length, dryRun: op.dryRun },
      'Removal preview created',
    );
    return formatRemovePreview(op, selection.excluded, selection.usedFreshList, config.commandPrefix);
  },
};
