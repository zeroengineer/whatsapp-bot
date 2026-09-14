import type { ConfirmToken } from '../core/parser.js';
import { totalTargets, type CommandContext } from '../core/types.js';
import { formatLeaveProgress, formatLeaveReport } from '../services/leaveService.js';
import { formatGroupProgress, formatOperationReport } from '../services/removalService.js';

/** Handles CONFIRM / CONFIRM REMOVEALL replies. Not a prefixed command, so not listed in the registry. */
export async function handleConfirm(ctx: CommandContext, token: ConfirmToken): Promise<string> {
  const { services, logger, msg, config } = ctx;
  const result = services.confirmations.consume(token, msg.timestamp);

  if (!result.ok) {
    logger.info({ action: 'confirm.rejected', reason: result.reason }, 'Confirmation rejected');
    switch (result.reason) {
      case 'none':
        return 'Nothing to confirm.';
      case 'expired':
        return 'That confirmation has expired. Nothing was removed. Run the command again for a fresh preview.';
      case 'stale':
        return 'That confirmation is older than the current preview and was ignored.';
      case 'wrong_token':
        return `This operation needs the reply:\n${result.expected}\n\nOr send ${config.commandPrefix}cancel.`;
    }
  }

  const op = result.op;

  if (op.type === 'leave') {
    const n = op.groups.length;
    logger.warn(
      { action: 'leave.confirmed', opId: op.id, groups: op.groups.map((g) => ({ groupJid: g.groupJid, groupName: g.groupName })), dryRun: op.dryRun },
      'Operation confirmed',
    );
    await ctx.send(
      op.dryRun
        ? `Dry run: checking ${n} group(s)…`
        : `Leaving ${n} group(s) and deleting their chats…\nSend ${config.commandPrefix}cancel to stop before the next step.`,
    );
    const report = await services.leave.execute(op, {
      onGroupDone: n > 1 ? (r, i, count) => ctx.send(formatLeaveProgress(r, i, count)) : undefined,
    });
    return formatLeaveReport(report);
  }

  const total = totalTargets(op);
  const multi = op.groups.length > 1;
  const where = multi ? `${op.groups.length} groups` : `"${op.groups[0]?.groupName}"`;
  logger.warn(
    {
      action: `${op.type}.confirmed`,
      opId: op.id,
      groups: op.groups.map((g) => ({ groupJid: g.groupJid, groupName: g.groupName, targetCount: g.targets.length })),
      targetCount: total,
      dryRun: op.dryRun,
    },
    'Operation confirmed',
  );
  await ctx.send(
    op.dryRun
      ? `Dry run: checking ${total} member(s) in ${where}…`
      : `Removing ${total} member(s) from ${where}…\nSend ${config.commandPrefix}cancel to stop after the current batch.`,
  );

  const report = await services.removal.execute(op, {
    onGroupDone: multi ? (groupReport, i, n) => ctx.send(formatGroupProgress(groupReport, i, n)) : undefined,
  });
  return formatOperationReport(report);
}
