import { describeOperation, UserError, type Command, type LeaveOperation } from '../core/types.js';
import { buildLeavePlan } from '../services/leaveService.js';

export function formatLeavePreview(op: LeaveOperation, undeletable: string[], prefix: string): string {
  const lines = [op.dryRun ? 'Leave Preview (DRY RUN)' : 'Leave Preview', '', `Groups: ${op.groups.length}`, ''];
  for (const g of op.groups) {
    const steps: string[] = [];
    if (g.adminsToRemove.length) steps.push(`demote & remove ${g.adminsToRemove.length} admin${g.adminsToRemove.length === 1 ? '' : 's'}`);
    steps.push('leave', 'delete chat');
    lines.push(`${g.index}. ${g.groupName}${g.selfIsAdmin ? ' [ADMIN]' : ''} — ${steps.join(', ')}`);
    if (g.adminsToRemove.length) lines.push(...g.adminsToRemove.map((t) => `   - ${t.label}`));
    if (g.creatorNotRemovable) lines.push(`   ${g.creatorNotRemovable.label} is the group creator and can't be removed (will remain)`);
  }
  if (undeletable.length > 0) {
    lines.push('', "Skipped (chat can't be deleted — no known messages):", ...undeletable.map((n) => `- ${n}`));
  }
  lines.push(
    '',
    op.dryRun ? 'Dry run: nothing will actually change.' : 'This cannot be undone.',
    '',
    'Reply:',
    'CONFIRM LEAVE',
    '',
    `(or ${prefix}cancel — expires in ${Math.round((op.expiresAt - op.createdAt) / 1000)}s)`,
  );
  return lines.join('\n');
}

export const leaveCommand: Command = {
  name: 'leave',
  usage: 'leave <group numbers | all>',
  description: 'Preview leaving groups and deleting their chats',
  async execute({ command, services, wa, config, logger, now }) {
    const p = config.commandPrefix;
    if (!command.args) {
      throw new UserError(`Usage: ${p}leave <group numbers>  (e.g. ${p}leave 2,5)\n   or: ${p}leave all  (after ${p}emptygroups or ${p}nonadmingroups)`);
    }
    if (services.removal.getRunning()) throw new UserError('Another operation is running. Wait for it to finish.');
    const pending = services.confirmations.getPending();
    if (pending) {
      throw new UserError(`Another operation is already pending (${describeOperation(pending)}). Confirm it or send ${p}cancel first.`);
    }

    const self = services.groups.requireSelf();
    const { groups } = await services.groups.resolveLeaveSelection(command.args, now());
    const deletable = groups.filter((g) => wa.canDeleteChat(g.group.jid));
    const undeletable = groups.filter((g) => !wa.canDeleteChat(g.group.jid)).map((g) => g.group.name);

    if (deletable.length === 0) {
      return [
        "Nothing to leave: none of the selected groups' chats can be deleted (no known messages).",
        '',
        ...undeletable.map((n) => `- ${n}`),
        '',
        'Wait until a message arrives in the group while the bot is running, then try again.',
      ].join('\n');
    }

    const op = services.confirmations.create({
      type: 'leave',
      groups: deletable.map(({ group, index }) => buildLeavePlan(group, index, self)),
      dryRun: config.dryRun || command.dryRun,
    });
    logger.warn(
      {
        action: 'leave.preview',
        opId: op.id,
        groups: op.groups.map((g) => ({ groupJid: g.groupJid, groupName: g.groupName, adminsToRemove: g.adminsToRemove.length })),
        skippedUndeletable: undeletable.length,
        dryRun: op.dryRun,
      },
      'Leave preview created',
    );
    return formatLeavePreview(op, undeletable, p);
  },
};
