import { describeOperation, type Command } from '../core/types.js';

export const cancelCommand: Command = {
  name: 'cancel',
  usage: 'cancel',
  description: 'Cancel the pending operation',
  async execute({ services, logger }) {
    const pending = services.confirmations.cancel();
    if (pending) {
      logger.info(
        { action: 'cancel', opId: pending.id, type: pending.type, groupJids: pending.groups.map((g) => g.groupJid) },
        'Pending operation cancelled',
      );
      return `Cancelled: ${describeOperation(pending)}. Nobody was removed.`;
    }
    const running = services.removal.getRunning();
    if (running && services.removal.requestCancel()) {
      logger.warn({ action: 'cancel.running', opId: running.opId }, 'Cancellation requested for running removal');
      const rest = running.groupCount > 1 ? ' Remaining groups will not be touched.' : '';
      return `Stopping the removal in "${running.groupName}" after the current batch.${rest} A report will follow.`;
    }
    return 'There is no pending operation.';
  },
};
